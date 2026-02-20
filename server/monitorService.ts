import mysql from 'mysql2/promise'
import { createClient } from 'redis'
import net from 'node:net'
import { connect as connectNats } from 'nats'

import { config } from './config'
import { pool } from './db'
import { MONITOR_CHECKED_EVENT, monitorEvents } from './events'
import { notifyStatusChange } from './notifier'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

type MonitorStatus = 'pending' | 'up' | 'down'
type MonitorType = 'http' | 'mysql' | 'redis' | 'nats' | 'tcp'

type JsonObject = Record<string, unknown>

interface MonitorEndpoint {
  id: number
  group_id: number
  group_name?: string | null
  name: string
  monitor_type: MonitorType
  url: string
  method: string
  headers_json: unknown
  body_text: string | null
  expected_status: number
  expected_json_path: string | null
  expected_json_value: string | null
  connection_json: unknown
  probe_command: string | null
  expected_probe_value: string | null
  interval_seconds: number
  down_retries: number
  up_retries: number
  status: MonitorStatus
  consecutive_failures: number
  consecutive_successes: number
  is_paused: number | boolean
}

interface CheckResult {
  checkPassed: boolean
  responseCode: number | null
  matchedValue: string | null
  errorMessage: string | null
}

interface ProbeValidationResult {
  ok: boolean
  matchedValue: string | null
  errorMessage: string | null
}

interface StatusComputation {
  status: MonitorStatus
  failures: number
  successes: number
}

interface MonitorCheckedPayload {
  endpointId: number
  groupId: number
  monitorType: MonitorType
  status: MonitorStatus
  responseCode: number | null
  lastCheckedAt: string
  lastError: string | null
  lastMatchValue: string | null
  consecutiveFailures: number
  consecutiveSuccesses: number
  responseTimeMs: number
  errorMessage: string | null
}

let timer: ReturnType<typeof setInterval> | null = null
let isTickRunning = false

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
  try {
    return JSON.parse(String(value))
  } catch {
    return null
  }
}

const parseHeaders = (headersJson: unknown): Record<string, string> => {
  if (!headersJson) return {}
  if (typeof headersJson === 'object' && !Array.isArray(headersJson)) {
    return Object.fromEntries(
      Object.entries(headersJson as JsonObject).map(([key, value]) => [key, String(value)]),
    )
  }

  const parsed = parseJson(headersJson)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return Object.fromEntries(
      Object.entries(parsed as JsonObject).map(([key, value]) => [key, String(value)]),
    )
  }
  return {}
}

const parseConnection = (connectionJson: unknown): JsonObject => {
  if (!connectionJson) return {}
  if (typeof connectionJson === 'object' && !Array.isArray(connectionJson)) {
    return connectionJson as JsonObject
  }

  const parsed = parseJson(connectionJson)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {}
}

const normalizeComparable = (value: unknown): string | null => {
  if (value === undefined) return '__UNDEFINED__'
  if (value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return left === right
}

const parseExpectedValue = (rawValue: unknown): unknown => {
  if (rawValue == null) return null
  const trimmed = String(rawValue).trim()

  if (trimmed === '') return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

const resolveJsonPath = (data: unknown, path: string | null | undefined): unknown => {
  if (!path) return undefined
  const tokens: Array<string | number> = []
  const matcher = /([^.[\]]+)|\[(\d+)\]/g

  for (const match of path.matchAll(matcher)) {
    tokens.push(match[1] ?? Number(match[2]))
  }

  return tokens.reduce<unknown>((acc, token) => {
    if (acc == null) return undefined
    if (typeof acc !== 'object') return undefined
    return (acc as Record<string | number, unknown>)[token]
  }, data)
}

const computeStatus = (endpoint: MonitorEndpoint, checkPassed: boolean): StatusComputation => {
  const downRetries = Math.max(1, Number(endpoint.down_retries) || 1)
  const upRetries = Math.max(1, Number(endpoint.up_retries) || 1)

  let failures = Number(endpoint.consecutive_failures) || 0
  let successes = Number(endpoint.consecutive_successes) || 0
  let status = endpoint.status ?? 'pending'

  if (checkPassed) {
    successes += 1
    failures = 0

    if (status === 'down') {
      if (successes >= upRetries) status = 'up'
    } else {
      status = 'up'
    }
  } else {
    failures += 1
    successes = 0

    if (status === 'up') {
      if (failures >= downRetries) status = 'down'
    } else if (failures >= downRetries) {
      status = 'down'
    }
  }

  return { status, failures, successes }
}

const getEndpointById = async (endpointId: number): Promise<MonitorEndpoint | null> => {
  const [rows] = await pool.query(
    `
      SELECT
        e.*,
        g.name AS group_name
      FROM monitor_endpoints e
      INNER JOIN monitor_groups g ON g.id = e.group_id
      WHERE e.id = ?
      LIMIT 1
    `,
    [endpointId],
  )

  return ((rows as MonitorEndpoint[])[0] ?? null)
}

const validateExpectedProbeValue = (
  actual: unknown,
  expectedRaw: unknown,
): ProbeValidationResult => {
  if (expectedRaw == null || String(expectedRaw).trim() === '') {
    return { ok: true, matchedValue: normalizeComparable(actual), errorMessage: null }
  }

  const expected = parseExpectedValue(expectedRaw)
  const ok = deepEqual(actual, expected)

  return {
    ok,
    matchedValue: normalizeComparable(actual),
    errorMessage: ok ? null : 'Probe value mismatch',
  }
}

async function runHttpCheck(endpoint: MonitorEndpoint): Promise<CheckResult> {
  const method = ALLOWED_METHODS.has(endpoint.method) ? endpoint.method : 'GET'
  const headers = parseHeaders(endpoint.headers_json)
  const body = endpoint.body_text || null

  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.requestTimeoutMs)

  let responseCode = null
  let matchedValue = null
  let errorMessage = null
  let checkPassed = false

  try {
    const shouldIncludeBody = !['GET', 'HEAD'].includes(method) && body

    const response = await fetch(endpoint.url, {
      method,
      headers,
      body: shouldIncludeBody ? body : undefined,
      signal: timeoutController.signal,
      redirect: 'follow',
    })

    responseCode = response.status

    let jsonValidationOk = true

    if (endpoint.expected_json_path && endpoint.expected_json_value != null) {
      const payload = await response.text()
      const parsed = parseJson(payload)

      if (parsed == null) {
        jsonValidationOk = false
        errorMessage = 'Expected JSON response but payload was not valid JSON'
      } else {
        const actual = resolveJsonPath(parsed, endpoint.expected_json_path)
        const expected = parseExpectedValue(endpoint.expected_json_value)

        matchedValue = actual === undefined ? null : normalizeComparable(actual)
        jsonValidationOk = deepEqual(actual, expected)

        if (!jsonValidationOk) {
          errorMessage = `JSON path mismatch at "${endpoint.expected_json_path}"`
        }
      }
    }

    checkPassed = response.status === endpoint.expected_status && jsonValidationOk

    if (!checkPassed && !errorMessage) {
      errorMessage = `Expected HTTP ${endpoint.expected_status}, got ${response.status}`
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown request error'
  } finally {
    clearTimeout(timeout)
  }

  return { checkPassed, responseCode, matchedValue, errorMessage }
}

async function runMysqlCheck(endpoint: MonitorEndpoint): Promise<CheckResult> {
  const connection = parseConnection(endpoint.connection_json)
  let conn: mysql.Connection | null = null

  try {
    if (typeof connection.url === 'string' && connection.url.trim()) {
      conn = await mysql.createConnection(connection.url)
    } else {
      conn = await mysql.createConnection({
        host: String(connection.host ?? '127.0.0.1'),
        port: Number(connection.port ?? 3306),
        user: connection.user == null ? undefined : String(connection.user),
        password: connection.password == null ? undefined : String(connection.password),
        database: connection.database == null ? undefined : String(connection.database),
        connectTimeout: config.requestTimeoutMs,
      })
    }

    const query = endpoint.probe_command?.trim() || 'SELECT 1 AS health'
    const [rows] = await conn.query(query)

    let actualValue: unknown = null
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && rows[0] !== null) {
      const firstRow = rows[0] as Record<string, unknown>
      const firstKey = Object.keys(firstRow)[0]
      actualValue = firstKey ? firstRow[firstKey] : null
    }

    const expectedResult = validateExpectedProbeValue(actualValue, endpoint.expected_probe_value)
    return {
      checkPassed: expectedResult.ok,
      responseCode: expectedResult.ok ? 200 : 500,
      matchedValue: expectedResult.matchedValue,
      errorMessage: expectedResult.errorMessage,
    }
  } catch (error) {
    return {
      checkPassed: false,
      responseCode: 500,
      matchedValue: null,
      errorMessage: error instanceof Error ? error.message : 'MySQL check failed',
    }
  } finally {
    if (conn) {
      await conn.end().catch(() => undefined)
    }
  }
}

const parseRedisCommand = (probeCommand: string | null | undefined): string[] => {
  if (!probeCommand || !probeCommand.trim()) return ['PING']

  const parsed = parseJson(probeCommand)
  if (Array.isArray(parsed) && parsed.length) {
    return parsed.map((part) => String(part))
  }

  return probeCommand
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

async function runRedisCheck(endpoint: MonitorEndpoint): Promise<CheckResult> {
  const connection = parseConnection(endpoint.connection_json)
  const client = createClient({
    ...(typeof connection.url === 'string' && connection.url.trim()
      ? { url: connection.url }
      : {
          socket: {
            host: String(connection.host ?? '127.0.0.1'),
            port: Number(connection.port ?? 6379),
            connectTimeout: config.requestTimeoutMs,
            reconnectStrategy: false,
          },
          username: connection.username == null ? undefined : String(connection.username),
          password: connection.password == null ? undefined : String(connection.password),
          database:
            connection.database == null ? undefined : Number(connection.database),
        }),
  })

  try {
    await withTimeout(client.connect(), config.requestTimeoutMs, 'Redis connect')

    const command = parseRedisCommand(endpoint.probe_command)
    const rawResult = await withTimeout(
      client.sendCommand(command),
      config.requestTimeoutMs,
      'Redis command',
    ) as unknown

    const commandName = String(command[0] ?? '').toUpperCase()
    const expectedRaw = endpoint.expected_probe_value ?? (commandName === 'PING' ? '"PONG"' : null)
    const expectedResult = validateExpectedProbeValue(rawResult, expectedRaw)

    return {
      checkPassed: expectedResult.ok,
      responseCode: expectedResult.ok ? 200 : 500,
      matchedValue: expectedResult.matchedValue,
      errorMessage: expectedResult.errorMessage,
    }
  } catch (error) {
    return {
      checkPassed: false,
      responseCode: 500,
      matchedValue: null,
      errorMessage: error instanceof Error ? error.message : 'Redis check failed',
    }
  } finally {
    if (client.isOpen) {
      await client.quit().catch(async () => {
        client.destroy()
      })
    }
  }
}

async function runNatsCheck(endpoint: MonitorEndpoint): Promise<CheckResult> {
  const connection = parseConnection(endpoint.connection_json)
  const serversRaw = connection.servers ?? connection.server ?? connection.url ?? 'nats://127.0.0.1:4222'
  const servers = Array.isArray(serversRaw)
    ? serversRaw.map((item) => String(item))
    : [String(serversRaw)]

  let nc: Awaited<ReturnType<typeof connectNats>> | null = null

  console.log(`Connecting to NATS servers: ${JSON.stringify(connection)}`)
  try {
    nc = await withTimeout(
      connectNats({
        servers,
        user: connection.user == null ? undefined : String(connection.user),
        pass: connection.password == null ? undefined : String(connection.password),
        token: connection.token == null ? undefined : String(connection.token),
        timeout: Number(connection.timeoutMs ?? config.requestTimeoutMs),
      }),
      config.requestTimeoutMs,
      'NATS connect',
    )

    const command = endpoint.probe_command?.trim() || 'jetstream.info'
    let actualValue: unknown = 'ok'

    if (command === 'jetstream.info') {
      const jsm = await nc.jetstreamManager()
      const accountInfo = await withTimeout(jsm.getAccountInfo(), config.requestTimeoutMs, 'JetStream info')
      actualValue = accountInfo != null ? 'ok' : null
    } else if (command.startsWith('stream.info:')) {
      const streamName = command.slice('stream.info:'.length).trim()
      if (!streamName) {
        return {
          checkPassed: false,
          responseCode: 500,
          matchedValue: null,
          errorMessage: 'stream.info command requires stream name',
        }
      }
      const jsm = await nc.jetstreamManager()
      const streamInfo = await withTimeout(
        jsm.streams.info(streamName),
        config.requestTimeoutMs,
        'JetStream stream info',
      )
      actualValue = streamInfo?.config?.name ?? null
    }

    const expectedRaw = endpoint.expected_probe_value ?? '"ok"'
    const expectedResult = validateExpectedProbeValue(actualValue, expectedRaw)

    return {
      checkPassed: expectedResult.ok,
      responseCode: expectedResult.ok ? 200 : 500,
      matchedValue: expectedResult.matchedValue,
      errorMessage: expectedResult.errorMessage,
    }
  } catch (error) {
    return {
      checkPassed: false,
      responseCode: 500,
      matchedValue: null,
      errorMessage: error instanceof Error ? error.message : 'NATS check failed',
    }
  } finally {
    if (nc) {
      await nc.close()
    }
  }
}

async function runTcpCheck(endpoint: MonitorEndpoint): Promise<CheckResult> {
  const connection = parseConnection(endpoint.connection_json)
  const host = String(connection.host ?? '127.0.0.1')
  const port = Number(connection.port ?? 80)
  const timeoutMs = Number(connection.timeoutMs ?? config.requestTimeoutMs)

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return {
      checkPassed: false,
      responseCode: 500,
      matchedValue: null,
      errorMessage: 'Invalid TCP port in connection_json',
    }
  }

  const connectPromise = new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection({ host, port })

    socket.once('connect', () => {
      socket.end()
      resolve('open')
    })
    socket.once('error', (error) => {
      socket.destroy()
      reject(error)
    })
  })

  try {
    const actualValue = await withTimeout(connectPromise, timeoutMs, 'TCP connect')
    const expectedRaw = endpoint.expected_probe_value ?? '"open"'
    const expectedResult = validateExpectedProbeValue(actualValue, expectedRaw)

    return {
      checkPassed: expectedResult.ok,
      responseCode: expectedResult.ok ? 200 : 500,
      matchedValue: expectedResult.matchedValue,
      errorMessage: expectedResult.errorMessage,
    }
  } catch (error) {
    return {
      checkPassed: false,
      responseCode: 500,
      matchedValue: null,
      errorMessage: error instanceof Error ? error.message : 'TCP check failed',
    }
  }
}

export async function runCheck(endpoint: MonitorEndpoint): Promise<MonitorCheckedPayload | null> {
  if (Number(endpoint.is_paused) === 1) {
    return null
  }

  const startedAt = Date.now()
  const previousStatus = endpoint.status ?? 'pending'

  let result: CheckResult
  if (endpoint.monitor_type === 'mysql') {
    result = await runMysqlCheck(endpoint)
  } else if (endpoint.monitor_type === 'redis') {
    result = await runRedisCheck(endpoint)
  } else if (endpoint.monitor_type === 'nats') {
    result = await runNatsCheck(endpoint)
  } else if (endpoint.monitor_type === 'tcp') {
    result = await runTcpCheck(endpoint)
  } else {
    result = await runHttpCheck(endpoint)
  }

  const next = computeStatus(endpoint, result.checkPassed)
  const responseTimeMs = Date.now() - startedAt

  await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        status = ?,
        consecutive_failures = ?,
        consecutive_successes = ?,
        last_checked_at = NOW(),
        last_response_code = ?,
        last_error = ?,
        last_match_value = ?,
        next_check_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
      WHERE id = ?
    `,
    [
      next.status,
      next.failures,
      next.successes,
      result.responseCode,
      result.errorMessage,
      result.matchedValue,
      endpoint.interval_seconds,
      endpoint.id,
    ],
  )

  await pool.query(
    `
      INSERT INTO monitor_check_runs
        (endpoint_id, status, response_code, matched_value, error_message, response_time_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      endpoint.id,
      next.status,
      result.responseCode,
      result.matchedValue,
      result.errorMessage,
      responseTimeMs,
    ],
  )

  const payload = {
    endpointId: endpoint.id,
    groupId: endpoint.group_id,
    monitorType: endpoint.monitor_type,
    status: next.status,
    responseCode: result.responseCode,
    lastCheckedAt: new Date().toISOString(),
    lastError: result.errorMessage ?? null,
    lastMatchValue: result.matchedValue ?? null,
    consecutiveFailures: next.failures,
    consecutiveSuccesses: next.successes,
    responseTimeMs,
    errorMessage: result.errorMessage ?? null,
  }

  monitorEvents.emit(MONITOR_CHECKED_EVENT, payload)

  if (previousStatus !== next.status && (next.status === 'up' || next.status === 'down')) {
    await notifyStatusChange({
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      groupId: endpoint.group_id,
      groupName: endpoint.group_name ?? null,
      monitorType: endpoint.monitor_type,
      url: endpoint.url,
      previousStatus,
      currentStatus: next.status,
      responseCode: result.responseCode,
      responseTimeMs,
      checkedAt: payload.lastCheckedAt,
      errorMessage: result.errorMessage ?? null,
      matchedValue: result.matchedValue ?? null,
    })
  }

  return payload
}

async function tick() {
  if (isTickRunning) return
  isTickRunning = true

  try {
    const [endpoints] = await pool.query(
      `
        SELECT
          e.*,
          g.name AS group_name
        FROM monitor_endpoints e
        INNER JOIN monitor_groups g ON g.id = e.group_id
        WHERE e.is_paused = 0 AND e.next_check_at <= NOW()
        ORDER BY e.next_check_at ASC
        LIMIT 50
      `,
    )

    await Promise.all((endpoints as MonitorEndpoint[]).map((endpoint: MonitorEndpoint) => runCheck(endpoint)))
  } finally {
    isTickRunning = false
  }
}

export function startMonitor() {
  if (timer) return

  timer = setInterval(() => {
    void tick()
  }, config.monitorPollMs)

  void tick()
}

export function stopMonitor() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export async function triggerCheckNow(endpointId: number): Promise<MonitorCheckedPayload | null> {
  const endpoint = await getEndpointById(endpointId)
  if (!endpoint) return null

  return runCheck(endpoint)
}
