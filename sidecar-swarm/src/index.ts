// Entry point: self-scheduling collection loop + graceful shutdown.
//
// setTimeout (not setInterval) reschedules only after each tick fully settles,
// so a slow tick can never overlap the next one.

import { COLLECTOR_VERSION, config, log } from './config'
import { collect } from './metrics'
import { finalFlush, send } from './sender'

const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000

let timer: ReturnType<typeof setTimeout> | null = null
let stopping = false
let ticking = false

const tick = async (): Promise<void> => {
  if (stopping || ticking) return
  ticking = true
  const startedAt = Date.now()
  try {
    const payload = await collect()
    await send(payload)
    log.debug('tick complete', {
      containers: payload.containers.length,
      node: payload.node.hostname,
      host_cpu_pct: payload.node.cpu_pct,
      took_ms: Date.now() - startedAt,
    })
  } catch (err) {
    // Tick-level failure (e.g. docker socket unreachable): log and skip; the
    // loop reschedules regardless.
    log.error('tick failed', { error: String(err), took_ms: Date.now() - startedAt })
  } finally {
    ticking = false
    schedule()
  }
}

const schedule = (): void => {
  if (stopping) return
  timer = setTimeout(tick, config.intervalMs)
}

const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return
  stopping = true
  log.info('shutting down', { signal })
  if (timer) clearTimeout(timer)

  // One last snapshot + best-effort flush of the backlog, on a short timeout.
  try {
    const payload = await collect()
    await finalFlush(payload, SHUTDOWN_FLUSH_TIMEOUT_MS)
  } catch (err) {
    log.warn('final collect/flush failed', { error: String(err) })
  }
  log.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) })
})
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: String(err) })
})

const main = (): void => {
  if (!config.ingestToken) {
    log.warn('METRICS_INGEST_TOKEN is empty — ingest will be rejected by the server')
  }
  log.info('sidecar starting', {
    collector_version: COLLECTOR_VERSION,
    ingest_url: config.ingestUrl,
    interval_ms: config.intervalMs,
    docker_socket: config.dockerSocket,
    host_proc: config.hostProc,
    stats_concurrency: config.statsConcurrency,
    buffer_max_batches: config.bufferMaxBatches,
  })
  // Fire the first tick immediately, then self-schedule.
  void tick()
}

main()
