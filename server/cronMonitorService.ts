import { randomUUID } from 'node:crypto'

import { CronExpressionParser } from 'cron-parser'
import { connect as connectNats, type NatsConnection } from 'nats'

import { config } from './config'
import { getAppSetting, pool, setAppSetting } from './db'
import { CRON_RUN_EVENT, monitorEvents } from './events'
import { notifyCronRun } from './notifier'

type JsonObject = Record<string, unknown>
type CronRow = Record<string, any>
type CronRunRow = Record<string, any>

type TriggerOutcome = {
  ok: boolean
  responseCode: number | null
  errorMessage: string | null
}

export type CronRunStatusReport = {
  runId: string
  cron: string
  status: 'start' | 'ping' | 'fail' | 'stop'
  error?: string | null
}

export type CronRunStatusResult = {
  accepted: boolean
  reason?: string
}

let timer: ReturnType<typeof setInterval> | null = null
let isTickRunning = false
let lastSweepAt = 0
let lastRetentionCleanupAt = 0
let natsConnectionPromise: Promise<NatsConnection> | null = null

const RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const INVALID_EXPRESSION_RETRY_MINUTES = 5
const DEFAULT_NATS_SUBJECT = 'crons.uptime_monitor'
const CRON_MONITOR_ENABLED_SETTING = 'cron_monitor_enabled'

export async function isCronMonitorEnabled(): Promise<boolean> {
  const value = await getAppSetting(CRON_MONITOR_ENABLED_SETTING)
  return value === '1' || value === 'true'
}

export async function setCronMonitorEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(CRON_MONITOR_ENABLED_SETTING, enabled ? '1' : '0')
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

const parseJson = (value: unknown): unknown => {
  if (value == null || value === '') return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

const parseHeaders = (headersJson: unknown): Record<string, string> => {
  const parsed = parseJson(headersJson)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return Object.fromEntries(
      Object.entries(parsed as JsonObject).map(([key, value]) => [key, String(value)]),
    )
  }
  return {}
}

const toErrorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback

const toSqlDateTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ')

export const computeNextRunAt = (expression: string, from: Date = new Date()): Date =>
  CronExpressionParser.parse(expression, { currentDate: from, tz: 'UTC' }).next().toDate()

const getNatsConnection = (): Promise<NatsConnection> => {
  if (!config.nats?.servers?.length) {
    return Promise.reject(new Error('NATS is not configured (set NATS_CLIENT in .env)'))
  }

  if (!natsConnectionPromise) {
    const pending = connectNats({
      servers: config.nats.servers,
      user: config.nats.user,
      pass: config.nats.pass,
      token: config.nats.token,
      maxReconnectAttempts: -1,
      waitOnFirstConnect: false,
      timeout: config.requestTimeoutMs,
    }).then((nc) => {
      void nc.closed().then(() => {
        if (natsConnectionPromise === pending) natsConnectionPromise = null
      })
      return nc
    })

    pending.catch(() => {
      if (natsConnectionPromise === pending) natsConnectionPromise = null
    })

    natsConnectionPromise = pending
  }

  return natsConnectionPromise
}

async function fireNatsTrigger(cron: CronRow, runId: string): Promise<TriggerOutcome> {
  try {
    const nc = await withTimeout(getNatsConnection(), config.requestTimeoutMs, 'NATS connect')
    const subject = String(cron.nats_subject ?? '').trim() || DEFAULT_NATS_SUBJECT
    const payload = JSON.stringify({ run_id: runId, cron: String(cron.cron) })

    nc.publish(subject, new TextEncoder().encode(payload))
    await withTimeout(nc.flush(), config.requestTimeoutMs, 'NATS flush')

    return { ok: true, responseCode: null, errorMessage: null }
  } catch (error) {
    return {
      ok: false,
      responseCode: null,
      errorMessage: toErrorMessage(error, 'NATS publish failed'),
    }
  }
}

async function fireHttpTrigger(cron: CronRow, runId: string): Promise<TriggerOutcome> {
  const method = String(cron.http_method).toUpperCase() === 'POST' ? 'POST' : 'GET'
  const headers = parseHeaders(cron.headers_json)

  let url: URL
  try {
    url = new URL(String(cron.endpoint ?? ''))
  } catch {
    return { ok: false, responseCode: null, errorMessage: 'Invalid trigger endpoint URL' }
  }

  let body: string | undefined
  let builtJsonBody = false

  if (method === 'GET') {
    url.searchParams.set('run_id', runId)
    url.searchParams.set('cron', String(cron.cron))
  } else {
    const customBody = parseJson(cron.body_text)
    if (customBody && typeof customBody === 'object' && !Array.isArray(customBody)) {
      body = JSON.stringify({ ...(customBody as JsonObject), run_id: runId, cron: String(cron.cron) })
      builtJsonBody = true
    } else if (cron.body_text) {
      // Raw non-JSON body is sent as-is; run info travels via query params instead.
      url.searchParams.set('run_id', runId)
      url.searchParams.set('cron', String(cron.cron))
      body = String(cron.body_text)
    } else {
      body = JSON.stringify({ run_id: runId, cron: String(cron.cron) })
      builtJsonBody = true
    }
  }

  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
  if (builtJsonBody && !hasContentType) {
    headers['Content-Type'] = 'application/json'
  }

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.requestTimeoutMs)

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'POST' ? body : undefined,
      signal: timeoutController.signal,
      redirect: 'follow',
    })

    await response.text().catch(() => '')

    if (!response.ok) {
      return {
        ok: false,
        responseCode: response.status,
        errorMessage: `Trigger endpoint returned HTTP ${response.status}`,
      }
    }

    return { ok: true, responseCode: response.status, errorMessage: null }
  } catch (error) {
    return {
      ok: false,
      responseCode: null,
      errorMessage: toErrorMessage(error, 'Unknown request error'),
    }
  } finally {
    clearTimeout(timeout)
  }
}

const loadRun = async (runId: string): Promise<CronRunRow | null> => {
  const [rows] = await pool.query(
    `
      SELECT
        r.*,
        c.expression,
        c.service,
        c.ping_window_seconds
      FROM cron_runs r
      LEFT JOIN cron_monitoring c ON c.cron = r.cron
      WHERE r.run_id = ?
      LIMIT 1
    `,
    [runId],
  )

  if (!rows.length) return null
  return rows[0]
}

const emitRunEvent = (run: CronRunRow): void => {
  monitorEvents.emit(CRON_RUN_EVENT, {
    runId: run.run_id,
    cron: run.cron,
    status: run.status,
    triggerType: run.trigger_type,
    triggeredAt: run.triggered_at,
    firstPingAt: run.first_ping_at,
    lastPingAt: run.last_ping_at,
    completedAt: run.completed_at,
    pings: Number(run.pings ?? 0),
    durationMs: run.duration_ms,
    responseCode: run.response_code,
    errorMessage: run.error_message,
  })
}

const notifyRunFailure = async (run: CronRunRow): Promise<void> => {
  await notifyCronRun({
    cron: run.cron,
    runId: run.run_id,
    outcome: run.status,
    expression: run.expression ?? null,
    service: run.service ?? null,
    triggerType: run.trigger_type,
    pings: Number(run.pings ?? 0),
    triggeredAt: run.triggered_at,
    firstPingAt: run.first_ping_at,
    lastPingAt: run.last_ping_at,
    durationMs: run.duration_ms,
    reason: run.error_message,
  })
}

const finalizeRun = async (runId: string, notifyFailure: boolean): Promise<void> => {
  const run = await loadRun(runId)
  if (!run) return

  emitRunEvent(run)
  if (notifyFailure && (run.status === 'failed' || run.status === 'missed')) {
    await notifyRunFailure(run)
  }
}

// Advances next_run_at with an optimistic claim so a row is processed at most
// once per occurrence. Returns true when this caller won the claim.
const claimNextRunAt = async (cron: CronRow): Promise<boolean> => {
  let nextRunAt: string
  try {
    nextRunAt = toSqlDateTime(computeNextRunAt(String(cron.expression)))
  } catch (error) {
    console.error(
      `[cron-monitor] invalid expression for cron=${cron.cron}: ${toErrorMessage(error, 'parse error')}`,
    )
    await pool.query(
      `
        UPDATE cron_monitoring
        SET next_run_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
        WHERE cron = ? AND next_run_at <=> ?
      `,
      [INVALID_EXPRESSION_RETRY_MINUTES, cron.cron, cron.next_run_at],
    )
    return false
  }

  const [result] = await pool.query(
    'UPDATE cron_monitoring SET next_run_at = ? WHERE cron = ? AND next_run_at <=> ?',
    [nextRunAt, cron.cron, cron.next_run_at],
  )

  return Boolean(result.affectedRows)
}

async function fireCron(cron: CronRow): Promise<void> {
  const claimed = await claimNextRunAt(cron)
  if (!claimed) return

  const runId = randomUUID()
  const triggerType = cron.trigger_type === 'http' ? 'http' : 'nats'

  await pool.query(
    `
      INSERT INTO cron_runs (run_id, cron, trigger_type, status, triggered_at)
      VALUES (?, ?, ?, 'triggered', UTC_TIMESTAMP())
    `,
    [runId, cron.cron, triggerType],
  )

  const outcome =
    triggerType === 'http' ? await fireHttpTrigger(cron, runId) : await fireNatsTrigger(cron, runId)

  if (!outcome.ok) {
    await pool.query(
      `
        UPDATE cron_runs
        SET
          status = 'failed',
          completed_at = UTC_TIMESTAMP(),
          duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000,
          response_code = ?,
          error_message = ?
        WHERE run_id = ? AND status IN ('triggered', 'running')
      `,
      [outcome.responseCode, outcome.errorMessage, runId],
    )
    await finalizeRun(runId, true)
    return
  }

  if (Number(cron.track_run) === 1) {
    await pool.query(
      `
        UPDATE cron_runs
        SET
          deadline_at = DATE_ADD(triggered_at, INTERVAL ? SECOND),
          response_code = ?
        WHERE run_id = ? AND status = 'triggered'
      `,
      [Number(cron.start_window_seconds) || 60, outcome.responseCode, runId],
    )
    await finalizeRun(runId, false)
    return
  }

  await pool.query(
    `
      UPDATE cron_runs
      SET
        status = 'success',
        completed_at = UTC_TIMESTAMP(),
        duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000,
        response_code = ?
      WHERE run_id = ? AND status = 'triggered'
    `,
    [outcome.responseCode, runId],
  )
  await finalizeRun(runId, false)
}

export async function recordCronRunStatus(report: CronRunStatusReport): Promise<CronRunStatusResult> {
  const run = await loadRun(report.runId)
  if (!run) {
    console.warn(`[cron-monitor] status report for unknown run=${report.runId} cron=${report.cron}`)
    return { accepted: false, reason: 'unknown_run' }
  }

  if (report.status === 'start' || report.status === 'ping') {
    const pingWindowSeconds = Number(run.ping_window_seconds) || 300
    const [result] = await pool.query(
      `
        UPDATE cron_runs
        SET
          status = 'running',
          pings = pings + 1,
          first_ping_at = COALESCE(first_ping_at, UTC_TIMESTAMP()),
          last_ping_at = UTC_TIMESTAMP(),
          deadline_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND)
        WHERE run_id = ? AND status IN ('triggered', 'running')
      `,
      [pingWindowSeconds, report.runId],
    )

    if (!result.affectedRows) return { accepted: false, reason: 'already_completed' }
    await finalizeRun(report.runId, false)
    return { accepted: true }
  }

  if (report.status === 'stop') {
    const [result] = await pool.query(
      `
        UPDATE cron_runs
        SET
          status = 'success',
          pings = pings + 1,
          first_ping_at = COALESCE(first_ping_at, UTC_TIMESTAMP()),
          last_ping_at = UTC_TIMESTAMP(),
          completed_at = UTC_TIMESTAMP(),
          duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000
        WHERE run_id = ? AND status IN ('triggered', 'running')
      `,
      [report.runId],
    )

    if (!result.affectedRows) return { accepted: false, reason: 'already_completed' }
    await finalizeRun(report.runId, false)
    return { accepted: true }
  }

  const [result] = await pool.query(
    `
      UPDATE cron_runs
      SET
        status = 'failed',
        pings = pings + 1,
        first_ping_at = COALESCE(first_ping_at, UTC_TIMESTAMP()),
        last_ping_at = UTC_TIMESTAMP(),
        completed_at = UTC_TIMESTAMP(),
        duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000,
        error_message = ?
      WHERE run_id = ? AND status IN ('triggered', 'running')
    `,
    [String(report.error ?? '').trim() || 'Run reported failure', report.runId],
  )

  if (!result.affectedRows) return { accepted: false, reason: 'already_completed' }
  await finalizeRun(report.runId, true)
  return { accepted: true }
}

async function sweepOverdueRuns(): Promise<void> {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        run_id,
        pings,
        TIMESTAMPDIFF(SECOND, triggered_at, UTC_TIMESTAMP()) AS elapsed_seconds
      FROM cron_runs
      WHERE status IN ('triggered', 'running')
        AND deadline_at IS NOT NULL
        AND deadline_at <= UTC_TIMESTAMP()
      LIMIT 100
    `,
  )

  for (const row of rows) {
    const message = `ping missing, received ${Number(row.pings ?? 0)} pings for ${Number(
      row.elapsed_seconds ?? 0,
    ).toFixed(2)} seconds`

    const [result] = await pool.query(
      `
        UPDATE cron_runs
        SET
          status = 'missed',
          completed_at = UTC_TIMESTAMP(),
          duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000,
          error_message = ?
        WHERE id = ? AND status IN ('triggered', 'running')
      `,
      [message, row.id],
    )

    if (!result.affectedRows) continue
    await finalizeRun(row.run_id, true)
  }
}

async function tick() {
  if (isTickRunning) return
  isTickRunning = true

  try {
    // Master switch persisted in app_settings: when off, nothing fires, no
    // sweeping and no missed-run alerts. Stale occurrences accumulated while
    // off are skipped by the catch-up grace logic once re-enabled.
    if (!(await isCronMonitorEnabled())) return

    if (Date.now() - lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS) {
      await pool.query(
        'DELETE FROM cron_runs WHERE triggered_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
        [config.cron.runRetentionDays],
      )
      lastRetentionCleanupAt = Date.now()
    }

    if (Date.now() - lastSweepAt >= config.cron.sweepIntervalMs) {
      await sweepOverdueRuns()
      lastSweepAt = Date.now()
    }

    const [crons] = await pool.query(
      `
        SELECT
          *,
          TIMESTAMPDIFF(SECOND, next_run_at, UTC_TIMESTAMP()) AS overdue_seconds
        FROM cron_monitoring
        WHERE status = 1 AND (next_run_at IS NULL OR next_run_at <= UTC_TIMESTAMP())
        ORDER BY next_run_at ASC
        LIMIT 50
      `,
    )

    await Promise.all(
      crons.map(async (cron: CronRow) => {
        try {
          // NULL means freshly migrated/edited: initialize the schedule without firing.
          if (cron.next_run_at == null) {
            await claimNextRunAt(cron)
            return
          }

          // Beyond the catch-up grace window: skip to the next occurrence instead
          // of firing late (e.g. charge crons after downtime).
          if (Number(cron.overdue_seconds ?? 0) * 1000 > config.cron.catchupGraceMs) {
            const advanced = await claimNextRunAt(cron)
            if (advanced) {
              console.warn(
                `[cron-monitor] skipped overdue occurrence for cron=${cron.cron} (overdue ${cron.overdue_seconds}s)`,
              )
            }
            return
          }

          await fireCron(cron)
        } catch (error) {
          console.error(
            `[cron-monitor] failed processing cron=${cron.cron}: ${toErrorMessage(error, 'unknown error')}`,
          )
        }
      }),
    )
  } catch (error) {
    console.error('[cron-monitor] tick failed:', error)
  } finally {
    isTickRunning = false
  }
}

export async function resetCronSchedule(cronName: string): Promise<void> {
  await pool.query('UPDATE cron_monitoring SET next_run_at = NULL WHERE cron = ?', [cronName])
}

export function startCronMonitor() {
  if (timer) return

  timer = setInterval(() => {
    void tick()
  }, config.cron.pollMs)
  void tick()
}

export async function stopCronMonitor() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  const pending = natsConnectionPromise
  natsConnectionPromise = null
  if (pending) {
    try {
      const nc = await pending
      await nc.drain()
    } catch {
      // Connection already closed or never established.
    }
  }
}
