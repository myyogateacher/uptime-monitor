import mysql from 'mysql2/promise'
import { createClient } from 'redis'

import { config } from './config.js'
import { pool } from './db.js'
import { MONITOR_CHECKED_EVENT, monitorEvents } from './events.js'
import { notifyStatusChange } from './notifier.js'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

let timer = null
let isTickRunning = false

const withTimeout = async (promise, timeoutMs, label) => {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
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

const parseJson = (value) => {
  if (value == null || value === '') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const parseHeaders = (headersJson) => {
  if (!headersJson) return {}
  if (typeof headersJson === 'object') return headersJson

  const parsed = parseJson(headersJson)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

const parseConnection = (connectionJson) => {
  if (!connectionJson) return {}
  if (typeof connectionJson === 'object') return connectionJson

  const parsed = parseJson(connectionJson)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

const normalizeComparable = (value) => {
  if (value === undefined) return '__UNDEFINED__'
  if (value === null) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const deepEqual = (left, right) => {
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right)
  }
  return left === right
}

const parseExpectedValue = (rawValue) => {
  if (rawValue == null) return null
  const trimmed = String(rawValue).trim()

  if (trimmed === '') return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

const resolveJsonPath = (data, path) => {
  if (!path) return undefined
  const tokens = []
  const matcher = /([^.[\]]+)|\[(\d+)\]/g

  for (const match of path.matchAll(matcher)) {
    tokens.push(match[1] ?? Number(match[2]))
  }

  return tokens.reduce((acc, token) => {
    if (acc == null) return undefined
    return acc[token]
  }, data)
}

const computeStatus = (endpoint, checkPassed) => {
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

const getEndpointById = async (endpointId) => {
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

  return rows[0] ?? null
}

const validateExpectedProbeValue = (actual, expectedRaw) => {
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

async function runHttpCheck(endpoint) {
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

async function runMysqlCheck(endpoint) {
  const connection = parseConnection(endpoint.connection_json)
  let conn

  try {
    if (connection.url) {
      conn = await mysql.createConnection(connection.url)
    } else {
      conn = await mysql.createConnection({
        host: connection.host ?? '127.0.0.1',
        port: Number(connection.port ?? 3306),
        user: connection.user,
        password: connection.password,
        database: connection.database,
        connectTimeout: config.requestTimeoutMs,
      })
    }

    const query = endpoint.probe_command?.trim() || 'SELECT 1 AS health'
    const [rows] = await conn.query(query)

    let actualValue = null
    if (Array.isArray(rows) && rows.length && typeof rows[0] === 'object' && rows[0] !== null) {
      const firstKey = Object.keys(rows[0])[0]
      actualValue = firstKey ? rows[0][firstKey] : null
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

const parseRedisCommand = (probeCommand) => {
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

async function runRedisCheck(endpoint) {
  const connection = parseConnection(endpoint.connection_json)
  const client = createClient({
    ...(connection.url
      ? { url: connection.url }
      : {
          socket: {
            host: connection.host ?? '127.0.0.1',
            port: Number(connection.port ?? 6379),
            connectTimeout: config.requestTimeoutMs,
            reconnectStrategy: false,
          },
          username: connection.username,
          password: connection.password,
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
    )

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

export async function runCheck(endpoint) {
  if (Number(endpoint.is_paused) === 1) {
    return null
  }

  const startedAt = Date.now()
  const previousStatus = endpoint.status ?? 'pending'

  let result
  if (endpoint.monitor_type === 'mysql') {
    result = await runMysqlCheck(endpoint)
  } else if (endpoint.monitor_type === 'redis') {
    result = await runRedisCheck(endpoint)
    console.log('Redis check completed with result:', result)
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

    await Promise.all(endpoints.map((endpoint) => runCheck(endpoint)))
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

export async function triggerCheckNow(endpointId) {
  const endpoint = await getEndpointById(endpointId)
  if (!endpoint) return null

  return runCheck(endpoint)
}
