// Ships batches to the server ingest endpoint. On failure batches go into a
// bounded ring buffer (oldest dropped, dropped count tracked and reported on
// the next successful POST). On success the backlog is flushed oldest-first.

import { config, log } from './config'
import type { MetricsIngestPayload } from './types'

// A few backlog batches are flushed per successful tick so a long outage
// drains gradually without hammering the server or blowing the HTTP timeout.
const BACKLOG_FLUSH_PER_TICK = 5

const buffer: MetricsIngestPayload[] = []
let droppedBatches = 0

const post = async (payload: MetricsIngestPayload, timeoutMs: number): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ingestToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ingest -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

const enqueue = (payload: MetricsIngestPayload): void => {
  buffer.push(payload)
  while (buffer.length > config.bufferMaxBatches) {
    buffer.shift()
    droppedBatches++
  }
}

// Send the current batch, then drain a slice of the backlog. Reports the
// accumulated dropped-batches count on the first success and resets it.
export const send = async (payload: MetricsIngestPayload): Promise<void> => {
  payload.dropped_batches = droppedBatches

  try {
    await post(payload, config.httpTimeoutMs)
    if (droppedBatches > 0) {
      log.warn('resumed ingest after drops', { dropped_batches: droppedBatches })
      droppedBatches = 0
    }
  } catch (err) {
    enqueue(payload)
    log.warn('ingest POST failed, buffered batch', {
      buffered: buffer.length,
      dropped_batches: droppedBatches,
      error: String(err),
    })
    return
  }

  // Success: drain backlog oldest-first, capped per tick.
  let flushed = 0
  while (buffer.length > 0 && flushed < BACKLOG_FLUSH_PER_TICK) {
    const next = buffer[0]!
    next.dropped_batches = droppedBatches
    try {
      await post(next, config.httpTimeoutMs)
      buffer.shift()
      flushed++
      if (droppedBatches > 0) droppedBatches = 0
    } catch (err) {
      log.debug('backlog flush stalled, will retry next tick', {
        buffered: buffer.length,
        error: String(err),
      })
      break
    }
  }
  if (flushed > 0) log.info('flushed buffered batches', { flushed, remaining: buffer.length })
}

// Best-effort final flush on shutdown: current batch plus any backlog, with a
// short timeout so SIGTERM is honored promptly.
export const finalFlush = async (
  payload: MetricsIngestPayload,
  timeoutMs: number,
): Promise<void> => {
  const pending = [...buffer, payload]
  pending[pending.length - 1]!.dropped_batches = droppedBatches
  for (const batch of pending) {
    try {
      await post(batch, timeoutMs)
    } catch (err) {
      log.warn('final flush batch failed', { error: String(err) })
      return
    }
  }
}

export const bufferedCount = (): number => buffer.length
