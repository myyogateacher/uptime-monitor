import { randomUUID } from 'node:crypto'

import { CronExpressionParser } from 'cron-parser'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { connect as connectNats, type NatsConnection } from 'nats'

import { config } from './config'
import { getAppSetting, getAppSettingRecord, pool, setAppSetting } from './db'
import { CRON_HEALTH_EVENT, CRON_RUN_EVENT, monitorEvents } from './events'
import { notifyCronRun } from './notifier'

type JsonObject = Record<string, unknown>

export type CronTriggerType = 'nats' | 'http'
export type CronHttpMethod = 'GET' | 'POST' | 'NONE'
export type CronHealthStatus = 'unknown' | 'healthy' | 'unhealthy'

// Row shape of the cron_monitoring table.
export interface CronRow extends RowDataPacket {
  cron: string
  expression: string
  service: string
  endpoint: string
  trigger_type: CronTriggerType
  http_method: CronHttpMethod
  headers_json: string | JsonObject | null
  body_text: string | null
  nats_subject: string
  start_window_seconds: number
  ping_window_seconds: number
  status: number
  track_run: number
  next_run_at: Date | string | null
  health_status: CronHealthStatus
  health_reason: string | null
  health_changed_at: Date | string | null
  last_success_at: Date | string | null
  stale_after_at: Date | string | null
  created_date: Date | string
  modified_date: Date | string
}

// Row shape of the cron_runs table.
export interface CronRunRow extends RowDataPacket {
  id: number
  run_id: string
  cron: string
  trigger_type: CronTriggerType
  status: string
  triggered_at: Date | string
  deadline_at: Date | string | null
  first_ping_at: Date | string | null
  last_ping_at: Date | string | null
  completed_at: Date | string | null
  pings: number
  late_pings: number
  duration_ms: number | null
  response_code: number | null
  error_message: string | null
  created_at: Date | string
}

interface CronRunDetailsRow extends CronRunRow {
  expression: string | null
  service: string | null
  start_window_seconds: number | null
  ping_window_seconds: number | null
}

interface DueCronRow extends CronRow {
  overdue_seconds: number | null
}

interface OverdueRunRow extends RowDataPacket {
  id: number
  run_id: string
  pings: number
  elapsed_seconds: number | null
  orphaned: number
}

// Minimal projection used by the health watchdog and health transitions.
interface CronHealthRow extends RowDataPacket {
  cron: string
  expression: string
  service: string | null
  trigger_type: CronTriggerType
  start_window_seconds: number
  ping_window_seconds: number
  health_status: CronHealthStatus
  health_reason: string | null
  last_success_at: Date | string | null
  stale_after_at: Date | string | null
}

const CRON_HEALTH_COLUMNS = `
  cron,
  expression,
  service,
  trigger_type,
  start_window_seconds,
  ping_window_seconds,
  health_status,
  health_reason,
  last_success_at,
  stale_after_at
`

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

export type CronMonitorSettings = {
  enabled: boolean
  updatedBy: string | null
  updatedAt: Date | string | null
}

export async function isCronMonitorEnabled(): Promise<boolean> {
  const value = await getAppSetting(CRON_MONITOR_ENABLED_SETTING)
  return value === '1' || value === 'true'
}

export async function getCronMonitorSettings(): Promise<CronMonitorSettings> {
  const record = await getAppSettingRecord(CRON_MONITOR_ENABLED_SETTING)
  return {
    enabled: record?.value === '1' || record?.value === 'true',
    updatedBy: record?.updated_by ?? null,
    updatedAt: record?.updated_at ?? null,
  }
}

export async function setCronMonitorEnabled(
  enabled: boolean,
  updatedBy: string | null = null,
): Promise<void> {
  await setAppSetting(CRON_MONITOR_ENABLED_SETTING, enabled ? '1' : '0', updatedBy)

  // Deadlines accumulated while the master switch was off would all be in the
  // past on re-enable. Disarm them; the next claim re-arms from the live clock.
  if (enabled) {
    await pool.query(
      `UPDATE cron_monitoring SET stale_after_at = NULL WHERE stale_after_at IS NOT NULL`,
    )
  }
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

// Compact age rendering for logs: seconds close in, coarser units further out.
const formatAgeMs = (ageMs: number): string => {
  const seconds = Math.round(ageMs / 1000)
  const abs = Math.abs(seconds)
  if (abs < 120) return `${seconds}s`
  if (abs < 7200) return `${Math.round(seconds / 60)}m`
  if (abs < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

// Run ids are caller-supplied (our own triggers mint a UUID), and status
// reports carry no timestamp of their own. A 13-digit id in a sane range is
// almost certainly epoch millis, so decode it to give the log a run time;
// anything else logs as n/a rather than guessing.
const RUN_ID_EPOCH_MS_MIN = Date.UTC(2001, 0, 1)
const RUN_ID_EPOCH_MS_MAX = Date.UTC(2100, 0, 1)

const runIdTimestamp = (runId: string): Date | null => {
  if (!/^\d{13}$/.test(runId)) return null
  const ms = Number(runId)
  if (ms < RUN_ID_EPOCH_MS_MIN || ms > RUN_ID_EPOCH_MS_MAX) return null
  return new Date(ms)
}

// Time context for run-scoped logs: when the run claims to be from, how stale
// that makes it, and when we processed the report.
const describeRunTiming = (runId: string, at: Date | string | null, now: Date = new Date()): string => {
  const runAt = at == null ? runIdTimestamp(runId) : new Date(at)
  const nowPart = `now=${now.toISOString()}`
  if (!runAt || Number.isNaN(runAt.getTime())) return `run_at=n/a age=n/a ${nowPart}`
  return `run_at=${runAt.toISOString()} age=${formatAgeMs(now.getTime() - runAt.getTime())} ${nowPart}`
}

export const computeNextRunAt = (expression: string, from: Date = new Date()): Date =>
  CronExpressionParser.parse(expression, { currentDate: from, tz: 'UTC' }).next().toDate()

// Dead man's switch deadline. By the time the *next* occurrence has come and
// gone, plus the run's own start/ping windows and a grace period, a healthy
// cron must have recorded a successful run. Nothing here depends on an event
// being consumed, so a dead consumer or a stuck queue still trips it.
export const computeStaleAfterAt = (
  expression: string,
  startWindowSeconds: number,
  pingWindowSeconds: number,
  from: Date = new Date(),
  graceMs: number = config.cron.healthGraceMs,
): Date => {
  const next = computeNextRunAt(expression, from)
  const windowMs =
    (Number(startWindowSeconds) || 0) * 1000 + (Number(pingWindowSeconds) || 0) * 1000 + graceMs
  return new Date(next.getTime() + Math.max(0, windowMs))
}

// A run whose full window (start + ping + grace) has elapsed can no longer be
// completed: a report arriving now came off a backlog, not a live execution.
export const isRunWindowExpired = (
  triggeredAt: Date | string,
  startWindowSeconds: number | null,
  pingWindowSeconds: number | null,
  now: Date = new Date(),
  graceMs: number = config.cron.healthGraceMs,
): boolean => {
  const triggered = new Date(triggeredAt).getTime()
  if (!Number.isFinite(triggered)) return false
  const windowMs =
    (Number(startWindowSeconds) || 60) * 1000 + (Number(pingWindowSeconds) || 60) * 1000 + graceMs
  return now.getTime() > triggered + windowMs
}

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

async function fireNatsTrigger(
  cron: CronRow,
  runId: string,
  triggeredAt: Date,
): Promise<TriggerOutcome> {
  try {
    const nc = await withTimeout(getNatsConnection(), config.requestTimeoutMs, 'NATS connect')
    const subject = String(cron.nats_subject ?? '').trim() || DEFAULT_NATS_SUBJECT
    // triggered_at/expires_at let a consumer draining a backlog recognise that a
    // payload is stale and skip the work instead of running it hours late.
    const expiresAt = new Date(
      triggeredAt.getTime() +
        ((Number(cron.start_window_seconds) || 60) + (Number(cron.ping_window_seconds) || 60)) *
          1000,
    )
    const payload = JSON.stringify({
      run_id: runId,
      cron: String(cron.cron),
      triggered_at: triggeredAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    })

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

const loadCronHealthRow = async (cronName: string): Promise<CronHealthRow | null> => {
  const [rows] = await pool.query<CronHealthRow[]>(
    `SELECT ${CRON_HEALTH_COLUMNS} FROM cron_monitoring WHERE cron = ? LIMIT 1`,
    [cronName],
  )
  return rows.length ? rows[0] : null
}

const emitCronHealthEvent = (
  row: CronHealthRow,
  healthStatus: CronHealthStatus,
  healthReason: string | null,
  staleAfterAt: Date | string | null,
  lastSuccessAt: Date | string | null,
): void => {
  monitorEvents.emit(CRON_HEALTH_EVENT, {
    cron: row.cron,
    healthStatus,
    healthReason,
    healthChangedAt: new Date().toISOString(),
    staleAfterAt,
    lastSuccessAt,
  })
}

// Routes cron health transitions through the same notifier the per-run
// failures use, so they land on the existing Slack/webhook targets.
const notifyCronHealthChange = async (
  row: CronHealthRow,
  outcome: 'stale' | 'recovered',
  reason: string | null,
  runId: string | null,
): Promise<void> => {
  await notifyCronRun({
    cron: row.cron,
    runId: runId ?? 'n/a',
    outcome,
    expression: row.expression ?? null,
    service: row.service ?? null,
    triggerType: row.trigger_type ?? null,
    pings: 0,
    triggeredAt: null,
    firstPingAt: null,
    lastPingAt: row.last_success_at ?? null,
    durationMs: null,
    reason,
  })
}

// Records a successful run as the monitor's heartbeat and re-arms the dead
// man's switch from now. Recovery from unhealthy notifies once, on transition.
const markCronHealthy = async (cronName: string, completedAt: Date | string | null): Promise<void> => {
  const row = await loadCronHealthRow(cronName)
  if (!row) return

  let staleAfterAt: string | null = null
  try {
    staleAfterAt = toSqlDateTime(
      computeStaleAfterAt(
        String(row.expression),
        Number(row.start_window_seconds),
        Number(row.ping_window_seconds),
      ),
    )
  } catch (error) {
    console.error(
      `[cron-monitor] cannot arm health watchdog for cron=${cronName}: ${toErrorMessage(error, 'parse error')}`,
    )
  }

  await pool.query(
    `
      UPDATE cron_monitoring
      SET
        last_success_at = COALESCE(?, UTC_TIMESTAMP()),
        stale_after_at = COALESCE(?, stale_after_at),
        health_status = 'healthy',
        health_reason = NULL,
        health_changed_at = IF(health_status = 'healthy', health_changed_at, UTC_TIMESTAMP())
      WHERE cron = ?
    `,
    [completedAt ?? null, staleAfterAt, cronName],
  )

  emitCronHealthEvent(row, 'healthy', null, staleAfterAt, completedAt ?? new Date().toISOString())

  if (row.health_status === 'unhealthy') {
    await notifyCronHealthChange(row, 'recovered', row.health_reason ?? 'Cron recovered', null)
  }
}

// `notify` is false when the caller already sent a per-run failure alert.
const markCronUnhealthy = async (
  cronName: string,
  reason: string,
  notify: boolean,
  runId: string | null = null,
): Promise<void> => {
  const row = await loadCronHealthRow(cronName)
  if (!row) return

  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE cron_monitoring
      SET health_status = 'unhealthy', health_reason = ?, health_changed_at = UTC_TIMESTAMP()
      WHERE cron = ? AND health_status <> 'unhealthy'
    `,
    [reason.slice(0, 512), cronName],
  )

  if (!result.affectedRows) return

  emitCronHealthEvent(row, 'unhealthy', reason, row.stale_after_at, row.last_success_at)
  if (notify) await notifyCronHealthChange(row, 'stale', reason, runId)
}

const loadRun = async (runId: string): Promise<CronRunDetailsRow | null> => {
  const [rows] = await pool.query<CronRunDetailsRow[]>(
    `
      SELECT
        r.*,
        c.expression,
        c.service,
        c.start_window_seconds,
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

const emitRunEvent = (run: CronRunDetailsRow): void => {
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

const notifyRunFailure = async (run: CronRunDetailsRow): Promise<void> => {
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

  if (run.status === 'success') {
    await markCronHealthy(run.cron, run.completed_at)
  } else if (run.status === 'failed' || run.status === 'missed') {
    // The per-run alert below is the notification for this incident, so the
    // monitor-level transition stays silent to avoid a duplicate message.
    await markCronUnhealthy(
      run.cron,
      `Run ${run.run_id} ${run.status}: ${run.error_message ?? 'no reason reported'}`,
      false,
      run.run_id,
    )
  }

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

  // Arm the dead man's switch only when it is not already armed. Advancing it
  // on every occurrence would let a cron whose runs never complete keep
  // pushing its own deadline into the future; only a success may do that.
  let staleAfterAt: string | null = null
  try {
    staleAfterAt = toSqlDateTime(
      computeStaleAfterAt(
        String(cron.expression),
        Number(cron.start_window_seconds),
        Number(cron.ping_window_seconds),
      ),
    )
  } catch {
    staleAfterAt = null
  }

  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE cron_monitoring
      SET next_run_at = ?, stale_after_at = COALESCE(stale_after_at, ?)
      WHERE cron = ? AND next_run_at <=> ?
    `,
    [nextRunAt, staleAfterAt, cron.cron, cron.next_run_at],
  )

  return Boolean(result.affectedRows)
}

async function fireCron(cron: CronRow): Promise<void> {
  const claimed = await claimNextRunAt(cron)
  if (!claimed) return

  const runId = randomUUID()
  const triggerType = cron.trigger_type === 'http' ? 'http' : 'nats'
  const triggeredAt = new Date()

  await pool.query(
    `
      INSERT INTO cron_runs (run_id, cron, trigger_type, status, triggered_at)
      VALUES (?, ?, ?, 'triggered', UTC_TIMESTAMP())
    `,
    [runId, cron.cron, triggerType],
  )

  const outcome =
    triggerType === 'http'
      ? await fireHttpTrigger(cron, runId)
      : await fireNatsTrigger(cron, runId, triggeredAt)

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

  // track_run off: the trigger was delivered but nobody reports back, so the
  // run is closed as successful on delivery alone. Delivery is not execution --
  // turn track_run on for crons where a silent consumer must be detected.
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

// Reports that show up after a run was closed out (the consumer recovered and
// drained a backlog) are counted separately: the original run keeps its
// outcome, timestamps and duration so a stale payload can never register as a
// fresh success.
const recordLateReport = async (runId: string): Promise<void> => {
  await pool.query('UPDATE cron_runs SET late_pings = late_pings + 1 WHERE run_id = ?', [runId])
}

const expireRun = async (runId: string, message: string): Promise<boolean> => {
  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE cron_runs
      SET
        status = 'missed',
        completed_at = UTC_TIMESTAMP(),
        duration_ms = TIMESTAMPDIFF(MICROSECOND, triggered_at, UTC_TIMESTAMP()) DIV 1000,
        error_message = ?
      WHERE run_id = ? AND status IN ('triggered', 'running')
    `,
    [message, runId],
  )
  return Boolean(result.affectedRows)
}

export async function recordCronRunStatus(report: CronRunStatusReport): Promise<CronRunStatusResult> {
  const run = await loadRun(report.runId)
  if (!run) {
    console.warn(
      `[cron-monitor] status report for unknown run=${report.runId} cron=${report.cron} ${describeRunTiming(report.runId, null)}`,
    )
    return { accepted: false, reason: 'unknown_run' }
  }

  if (report.cron && String(run.cron) !== report.cron) {
    console.warn(
      `[cron-monitor] status report cron mismatch run=${report.runId} reported=${report.cron} actual=${run.cron} ${describeRunTiming(report.runId, run.triggered_at)}`,
    )
    return { accepted: false, reason: 'cron_mismatch' }
  }

  // Already closed out: count the late arrival, leave the run untouched.
  if (run.status !== 'triggered' && run.status !== 'running') {
    await recordLateReport(report.runId)
    return {
      accepted: false,
      reason: run.status === 'missed' ? 'run_expired' : 'already_completed',
    }
  }

  // Still open but past its whole window -- the sweeper has not reached it yet,
  // or the run was orphaned without a deadline. Either way this report came off
  // a backlog, so close the run as missed instead of accepting it.
  if (
    isRunWindowExpired(run.triggered_at, run.start_window_seconds, run.ping_window_seconds)
  ) {
    const closed = await expireRun(
      report.runId,
      `late "${report.status}" report received after the run window elapsed`,
    )
    await recordLateReport(report.runId)
    if (closed) await finalizeRun(report.runId, true)
    return { accepted: false, reason: 'run_expired' }
  }

  if (report.status === 'start' || report.status === 'ping') {
    const pingWindowSeconds = Number(run.ping_window_seconds) || 300
    const [result] = await pool.query<ResultSetHeader>(
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
    const [result] = await pool.query<ResultSetHeader>(
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

  const [result] = await pool.query<ResultSetHeader>(
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
  const graceSeconds = Math.ceil(config.cron.healthGraceMs / 1000)

  // The second branch catches orphaned runs: rows that were inserted but never
  // got a deadline (process died mid-fire, or the deadline update lost a race).
  // Without it they sit in 'triggered' forever and never turn into an alert.
  const [rows] = await pool.query<OverdueRunRow[]>(
    `
      SELECT
        r.id,
        r.run_id,
        r.pings,
        TIMESTAMPDIFF(SECOND, r.triggered_at, UTC_TIMESTAMP()) AS elapsed_seconds,
        (r.deadline_at IS NULL) AS orphaned
      FROM cron_runs r
      LEFT JOIN cron_monitoring c ON c.cron = r.cron
      WHERE r.status IN ('triggered', 'running')
        AND (
          (r.deadline_at IS NOT NULL AND r.deadline_at <= UTC_TIMESTAMP())
          OR (
            r.deadline_at IS NULL
            AND r.triggered_at <= DATE_SUB(
              UTC_TIMESTAMP(),
              INTERVAL (
                COALESCE(c.start_window_seconds, 60) + COALESCE(c.ping_window_seconds, 60) + ?
              ) SECOND
            )
          )
        )
      ORDER BY r.id ASC
      LIMIT 100
    `,
    [graceSeconds],
  )

  for (const row of rows) {
    const elapsed = Number(row.elapsed_seconds ?? 0).toFixed(2)
    const message = Number(row.orphaned)
      ? `run never reached a deadline and was abandoned after ${elapsed} seconds`
      : `ping missing, received ${Number(row.pings ?? 0)} pings for ${elapsed} seconds`

    const [result] = await pool.query<ResultSetHeader>(
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

// Dead man's switch. Runs off cron_monitoring alone, so a cron goes unhealthy
// when no successful run lands in time -- whether that is because the consumer
// is down, the queue is stuck, the trigger never fired, or no run row was ever
// created. None of those produce a run-state transition to hang an alert on.
async function sweepStaleCrons(): Promise<void> {
  const [rows] = await pool.query<CronHealthRow[]>(
    `
      SELECT ${CRON_HEALTH_COLUMNS}
      FROM cron_monitoring
      WHERE status = 1
        AND stale_after_at IS NOT NULL
        AND stale_after_at <= UTC_TIMESTAMP()
        AND health_status <> 'unhealthy'
      ORDER BY stale_after_at ASC
      LIMIT 100
    `,
  )

  for (const row of rows) {
    const since = row.last_success_at
      ? new Date(row.last_success_at).toISOString()
      : 'never (no successful run on record)'
    const expectedBy = row.stale_after_at ? new Date(row.stale_after_at).toISOString() : 'n/a'
    const reason = `No successful run since ${since}; a completed run was expected by ${expectedBy}. The trigger may not have been consumed (dead consumer or stuck queue).`

    console.warn(`[cron-monitor] cron=${row.cron} is stale: ${reason}`)
    await markCronUnhealthy(row.cron, reason, true)
  }
}

async function tick(): Promise<void> {
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
      await sweepStaleCrons()
      lastSweepAt = Date.now()
    }

    const [crons] = await pool.query<DueCronRow[]>(
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
      crons.map(async (cron) => {
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
  // The schedule (and therefore the health deadline) changed: disarm the
  // watchdog so the next claim re-arms it against the new expression.
  await pool.query(
    'UPDATE cron_monitoring SET next_run_at = NULL, stale_after_at = NULL WHERE cron = ?',
    [cronName],
  )
}

export function startCronMonitor(): void {
  if (timer) return

  timer = setInterval(() => {
    void tick()
  }, config.cron.pollMs)
  void tick()
}

export async function stopCronMonitor(): Promise<void> {
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
