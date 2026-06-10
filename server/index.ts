import path from 'node:path'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import cors, { type CorsOptions } from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import session from 'express-session'
import createMySqlSession from 'express-mysql-session'
import { WebSocket, WebSocketServer } from 'ws'

import { config } from './config'
import { initDatabase, pool } from './db'
import {
  CRON_CREATED_EVENT,
  CRON_DELETED_EVENT,
  CRON_UPDATED_EVENT,
  ENDPOINT_CREATED_EVENT,
  ENDPOINT_DELETED_EVENT,
  ENDPOINT_UPDATED_EVENT,
  GROUP_CREATED_EVENT,
  GROUP_DELETED_EVENT,
  GROUP_UPDATED_EVENT,
  MONITOR_CHECKED_EVENT,
  monitorEvents,
} from './events'
import { startMonitor, stopMonitor, triggerCheckNow } from './monitorService'

type JsonObject = Record<string, unknown>
type WsFrame = { type: string; payload?: unknown; timestamp?: string }
type MonitorType = 'http' | 'mysql' | 'redis' | 'nats' | 'tcp'
type StatsGranularity = 'minute' | 'hour' | 'day'
type StatsMode = 'aggregate' | 'raw'

const app = express()
const httpServer = createServer(app)
const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' })
const wsClients: Set<WebSocket> = new Set()
const MySQLSessionStore = createMySqlSession(session)
const sessionStore = new MySQLSessionStore({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: config.auth.sessionMaxAgeMs,
  createDatabaseTable: true,
})

const safeSend = (ws: WebSocket, message: WsFrame): void => {
  if (ws.readyState !== 1) return
  ws.send(JSON.stringify(message))
}

wsServer.on('connection', (ws: WebSocket) => {
  wsClients.add(ws)
  safeSend(ws, { type: 'connected', timestamp: new Date().toISOString() })

  ws.on('close', () => {
    wsClients.delete(ws)
  })
})

const broadcast = (type: string, payload: unknown): void => {
  const message = { type, payload }
  for (const client of wsClients) {
    safeSend(client, message as WsFrame)
  }
}

monitorEvents.on(MONITOR_CHECKED_EVENT, (payload) => {
  broadcast(MONITOR_CHECKED_EVENT, payload)
})

monitorEvents.on(GROUP_CREATED_EVENT, (payload) => {
  broadcast(GROUP_CREATED_EVENT, payload)
})

monitorEvents.on(GROUP_UPDATED_EVENT, (payload) => {
  broadcast(GROUP_UPDATED_EVENT, payload)
})

monitorEvents.on(GROUP_DELETED_EVENT, (payload) => {
  broadcast(GROUP_DELETED_EVENT, payload)
})

monitorEvents.on(ENDPOINT_CREATED_EVENT, (payload) => {
  broadcast(ENDPOINT_CREATED_EVENT, payload)
})

monitorEvents.on(ENDPOINT_UPDATED_EVENT, (payload) => {
  broadcast(ENDPOINT_UPDATED_EVENT, payload)
})

monitorEvents.on(ENDPOINT_DELETED_EVENT, (payload) => {
  broadcast(ENDPOINT_DELETED_EVENT, payload)
})

monitorEvents.on(CRON_CREATED_EVENT, (payload) => {
  broadcast(CRON_CREATED_EVENT, payload)
})

monitorEvents.on(CRON_UPDATED_EVENT, (payload) => {
  broadcast(CRON_UPDATED_EVENT, payload)
})

monitorEvents.on(CRON_DELETED_EVENT, (payload) => {
  broadcast(CRON_DELETED_EVENT, payload)
})

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (config.corsOrigins.includes(origin)) return callback(null, true)
    return callback(new Error(`Origin ${origin} is not allowed by CORS`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}

app.use(cors(corsOptions))
app.options(/.*/, cors(corsOptions))

if (config.auth.trustProxy) {
  app.set('trust proxy', 1)
}

app.use(
  session({
    name: 'uptime.sid',
    secret: config.auth.sessionSecret,
    store: sessionStore,
    proxy: config.auth.trustProxy,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: config.auth.sessionMaxAgeMs,
    },
  }),
)

app.use(express.json({ limit: '1mb' }))

const MONITOR_TYPES = new Set(['http', 'mysql', 'redis', 'nats', 'tcp'])
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const ALLOWED_STATS_GRANULARITIES = new Set<StatsGranularity>(['minute', 'hour', 'day'])
const ALLOWED_STATS_MODES = new Set<StatsMode>(['aggregate', 'raw'])
const MAX_RANGE_DAYS_BY_GRANULARITY: Record<StatsGranularity, number> = {
  minute: 2,
  hour: 30,
  day: 90,
}

const toInteger = (value: unknown, fallback: number | null = null): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.trunc(parsed)
}

const SENSITIVE_JSON_KEYS = new Set(['password', 'pass', 'pwd'])
const MASKED_JSON_VALUE = '*****'

const isSensitiveJsonKey = (key: string): boolean =>
  SENSITIVE_JSON_KEYS.has(String(key).trim().toLowerCase())

const maskSensitiveJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveJson(item))
  }

  if (value && typeof value === 'object') {
    const masked: JsonObject = {}
    for (const [key, val] of Object.entries(value as JsonObject)) {
      if (isSensitiveJsonKey(key) && val != null && val !== '') {
        masked[key] = MASKED_JSON_VALUE
      } else {
        masked[key] = maskSensitiveJson(val)
      }
    }
    return masked
  }

  return value
}

const restoreMaskedJson = (incoming: unknown, existing: unknown): unknown => {
  if (Array.isArray(incoming)) return incoming

  if (incoming && typeof incoming === 'object') {
    const existingObj =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? (existing as JsonObject)
        : {}
    const result: JsonObject = {}
    for (const [key, val] of Object.entries(incoming as JsonObject)) {
      if (isSensitiveJsonKey(key) && val === MASKED_JSON_VALUE && key in existingObj) {
        result[key] = existingObj[key]
      } else {
        result[key] = val
      }
    }
    return result
  }

  return incoming
}

const parseJsonObjectInput = (value: unknown, fieldLabel: string): JsonObject => {
  if (value == null || value === '') return {}

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldLabel} must be a JSON object or JSON string`)
  }

  const parsed = JSON.parse(value)

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel} must be a JSON object`)
  }

  return parsed
}

const normalizeHttpPayload = (payload: JsonObject): JsonObject => {
  const url = String(payload.url ?? '').trim()
  const method = String(payload.method ?? 'GET').toUpperCase()
  const bodyText = payload.body_text == null ? null : String(payload.body_text)
  const expectedStatus = toInteger(payload.expected_status, NaN)
  const expectedJsonPath = String(payload.expected_json_path ?? '').trim() || null
  const expectedJsonValue =
    payload.expected_json_value == null || String(payload.expected_json_value).trim() === ''
      ? null
      : String(payload.expected_json_value)
  const headers = parseJsonObjectInput(payload.headers_json, 'Headers')

  if (!url) throw new Error('URL is required for HTTP monitors')

  try {
    const parsedUrl = new URL(url)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('URL must use http or https')
    }
  } catch {
    throw new Error('URL must be a valid absolute URL')
  }

  if (!ALLOWED_METHODS.has(method)) {
    throw new Error('Unsupported HTTP method')
  }

  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new Error('expected_status must be between 100 and 599')
  }

  if ((expectedJsonPath && !expectedJsonValue) || (!expectedJsonPath && expectedJsonValue)) {
    throw new Error('expected_json_path and expected_json_value must both be provided together')
  }

  return {
    url,
    method,
    headers_json: JSON.stringify(headers),
    body_text: bodyText,
    expected_status: expectedStatus,
    expected_json_path: expectedJsonPath,
    expected_json_value: expectedJsonValue,
    connection_json: null,
    probe_command: null,
    expected_probe_value: null,
  }
}

const normalizeConnectionMonitorPayload = (
  payload: JsonObject,
  monitorType: MonitorType,
): JsonObject => {
  const connection = parseJsonObjectInput(payload.connection_json, 'connection_json')
  const probeCommand = String(payload.probe_command ?? '').trim() || null
  const expectedProbeValue =
    payload.expected_probe_value == null || String(payload.expected_probe_value).trim() === ''
      ? null
      : String(payload.expected_probe_value)

  const defaultPortByType = {
    mysql: 3306,
    redis: 6379,
    nats: 4222,
    tcp: 80,
  }

  const defaultPort = defaultPortByType[monitorType] ?? 80
  const host = connection.host ?? '127.0.0.1'
  const port = Number(connection.port ?? defaultPort)

  if (!connection.url && (!host || !Number.isFinite(port))) {
    throw new Error('connection_json must include a valid host/port or url')
  }

  return {
    url: String(payload.url ?? `${monitorType}://${host}:${port}`),
    method: 'GET',
    headers_json: JSON.stringify({}),
    body_text: null,
    expected_status: 200,
    expected_json_path: null,
    expected_json_value: null,
    connection_json: JSON.stringify(connection),
    probe_command: probeCommand,
    expected_probe_value: expectedProbeValue,
  }
}

const normalizeEndpointPayload = (payload: JsonObject): JsonObject => {
  const name = String(payload.name ?? '').trim()
  const monitorTypeRaw = String(payload.monitor_type ?? 'http').trim().toLowerCase()
  const intervalSeconds = toInteger(payload.interval_seconds, NaN)
  const downRetries = toInteger(payload.down_retries, NaN)
  const upRetries = toInteger(payload.up_retries, NaN)
  const groupId = toInteger(payload.group_id, NaN)

  if (!name) throw new Error('Name is required')

  if (!MONITOR_TYPES.has(monitorTypeRaw)) {
    throw new Error('monitor_type must be one of http, mysql, redis, nats, tcp')
  }
  const monitorType = monitorTypeRaw as MonitorType

  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5) {
    throw new Error('interval_seconds must be at least 5 seconds')
  }

  if (!Number.isInteger(downRetries) || downRetries < 1) {
    throw new Error('down_retries must be at least 1')
  }

  if (!Number.isInteger(upRetries) || upRetries < 1) {
    throw new Error('up_retries must be at least 1')
  }

  if (!Number.isInteger(groupId) || groupId < 1) {
    throw new Error('group_id must be a valid group id')
  }

  const monitorSpecific =
    monitorType === 'http'
      ? normalizeHttpPayload(payload)
      : normalizeConnectionMonitorPayload(payload, monitorType)

  return {
    name,
    monitor_type: monitorType,
    interval_seconds: intervalSeconds,
    down_retries: downRetries,
    up_retries: upRetries,
    group_id: groupId,
    ...monitorSpecific,
  }
}

const mapEndpointRow = (row: Record<string, any>): Record<string, any> => {
  const parseOrDefault = (value: unknown, fallback: JsonObject = {}): JsonObject => {
    if (!value) return fallback
    if (typeof value === 'object') return value as JsonObject

    try {
      return JSON.parse(String(value))
    } catch {
      return fallback
    }
  }

  return {
    ...row,
    is_paused: Number(row.is_paused) === 1,
    headers_json: parseOrDefault(row.headers_json, {}),
    connection_json: maskSensitiveJson(parseOrDefault(row.connection_json, {})) as JsonObject,
  }
}

const CRON_TRIGGER_TYPES = new Set(['nats', 'http'])
const CRON_HTTP_METHODS = new Set(['GET', 'POST', 'NONE'])
const CRON_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/

const normalizeCronPayload = (payload: JsonObject): JsonObject => {
  const cron = String(payload.cron ?? '').trim()
  const expression = String(payload.expression ?? '').trim()
  const service = String(payload.service ?? '').trim()
  const endpoint = String(payload.endpoint ?? '').trim()
  const triggerType = String(payload.trigger_type ?? 'nats').trim().toLowerCase()
  const httpMethod = String(payload.http_method ?? 'NONE').trim().toUpperCase()
  const startWindowSeconds = toInteger(payload.start_window_seconds, NaN)
  const pingWindowSeconds = toInteger(payload.ping_window_seconds, NaN)
  const status = Number(payload.status ?? 1) ? 1 : 0
  const trackRun = Number(payload.track_run ?? 1) ? 1 : 0

  if (!cron) throw new Error('Cron name is required')
  if (cron.length > 100) throw new Error('Cron name must be at most 100 characters')
  if (!CRON_NAME_PATTERN.test(cron)) {
    throw new Error('Cron name may only contain letters, numbers, "_", "-", "." and ":"')
  }

  if (!expression) throw new Error('Cron expression is required')
  if (expression.length > 100) throw new Error('Cron expression must be at most 100 characters')
  if (expression.split(/\s+/).length !== 5) {
    throw new Error('Cron expression must have 5 fields (minute hour day month weekday)')
  }

  if (service.length > 255) throw new Error('Service must be at most 255 characters')
  if (endpoint.length > 256) throw new Error('Endpoint must be at most 256 characters')

  if (!CRON_TRIGGER_TYPES.has(triggerType)) {
    throw new Error('trigger_type must be one of nats, http')
  }

  if (!CRON_HTTP_METHODS.has(httpMethod)) {
    throw new Error('http_method must be one of GET, POST, NONE')
  }

  if (triggerType === 'http') {
    if (!endpoint) throw new Error('Endpoint is required for HTTP triggers')
    try {
      const parsedUrl = new URL(endpoint)
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('invalid protocol')
      }
    } catch {
      throw new Error('Endpoint must be a valid absolute http(s) URL')
    }
    if (httpMethod === 'NONE') {
      throw new Error('http_method must be GET or POST for HTTP triggers')
    }
  }

  if (!Number.isInteger(startWindowSeconds) || startWindowSeconds < 0) {
    throw new Error('start_window_seconds must be a non-negative integer')
  }

  if (!Number.isInteger(pingWindowSeconds) || pingWindowSeconds < 0) {
    throw new Error('ping_window_seconds must be a non-negative integer')
  }

  return {
    cron,
    expression,
    service,
    endpoint,
    trigger_type: triggerType,
    http_method: triggerType === 'http' ? httpMethod : 'NONE',
    start_window_seconds: startWindowSeconds,
    ping_window_seconds: pingWindowSeconds,
    status,
    track_run: trackRun,
  }
}

const mapCronRow = (row: Record<string, any>): Record<string, any> => ({
  ...row,
  status: Number(row.status) === 1,
  track_run: Number(row.track_run) === 1,
})

const getMappedCronByName = async (cronName: string): Promise<Record<string, any> | null> => {
  const [rows] = await pool.query('SELECT * FROM cron_monitoring WHERE cron = ? LIMIT 1', [cronName])
  if (!rows.length) return null
  return mapCronRow(rows[0])
}

const getStatsBucketSql = (granularity: StatsGranularity): string => {
  if (granularity === 'minute') {
    return "DATE_FORMAT(CONVERT_TZ(checked_at, '+00:00', '+00:00'), '%Y-%m-%d %H:%i:00')"
  }

  if (granularity === 'hour') {
    return "DATE_FORMAT(CONVERT_TZ(checked_at, '+00:00', '+00:00'), '%Y-%m-%d %H:00:00')"
  }

  return "DATE_FORMAT(CONVERT_TZ(checked_at, '+00:00', '+00:00'), '%Y-%m-%d 00:00:00')"
}

const parseStatsGranularity = (value: unknown): StatsGranularity => {
  const normalized = String(value ?? 'hour').trim().toLowerCase() as StatsGranularity
  return ALLOWED_STATS_GRANULARITIES.has(normalized) ? normalized : 'hour'
}

const parseStatsRangeDays = (value: unknown, granularity: StatsGranularity): number => {
  const maxRangeDays = MAX_RANGE_DAYS_BY_GRANULARITY[granularity]
  const parsed = toInteger(value, maxRangeDays) ?? maxRangeDays
  return Math.max(1, Math.min(parsed, maxRangeDays))
}

const parseStatsMode = (value: unknown): StatsMode => {
  const normalized = String(value ?? 'aggregate').trim().toLowerCase() as StatsMode
  return ALLOWED_STATS_MODES.has(normalized) ? normalized : 'aggregate'
}

const getMappedEndpointById = async (endpointId: number): Promise<Record<string, any> | null> => {
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

  if (!rows.length) return null
  return mapEndpointRow(rows[0])
}

const getMappedEndpointsByGroupId = async (groupId: number): Promise<Array<Record<string, any>>> => {
  const [rows] = await pool.query(
    `
      SELECT
        e.*,
        g.name AS group_name
      FROM monitor_endpoints e
      INNER JOIN monitor_groups g ON g.id = e.group_id
      WHERE e.group_id = ?
      ORDER BY e.name ASC
    `,
    [groupId],
  )

  return rows.map(mapEndpointRow)
}

const isAuthenticated = (req: Request): boolean => Boolean(req.session?.user)
const getSessionEmail = (req: Request): string =>
  String(req.session?.user?.email ?? '')
    .trim()
    .toLowerCase()
const canEditControlPlane = (req: Request): boolean => {
  if (!isAuthenticated(req)) return false
  const allowlist = config.auth.editorEmails
  if (!allowlist.length) return true
  const email = getSessionEmail(req)
  return allowlist.includes(email)
}

const requireEditor = (req: Request, res: Response, next: NextFunction) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  if (canEditControlPlane(req)) return next()
  return res.status(403).json({ error: 'You do not have permission to edit monitors' })
}

const requireGoogleConfig = (res: Response): boolean => {
  const google = config.auth.google
  if (!google.clientId || !google.clientSecret || !google.redirectUri) {
    res.status(500).json({ error: 'Google auth is not configured' })
    return false
  }
  return true
}

const buildLoginUrl = (returnTo?: string): string => {
  const params = new URLSearchParams()
  if (returnTo) params.set('returnTo', returnTo)
  const suffix = params.toString()
  return `${config.auth.loginPath}${suffix ? `?${suffix}` : ''}`
}

app.get('/api/auth/me', (req: Request, res: Response) => {
  if (!req.session?.user) {
    return res.status(200).json({ authenticated: false, user: null, canEdit: false })
  }

  return res.status(200).json({
    authenticated: true,
    user: req.session.user,
    canEdit: canEditControlPlane(req),
  })
})

app.get('/api/auth/google', (req: Request, res: Response) => {
  if (!requireGoogleConfig(res)) return

  const state = randomUUID()
  req.session.oauthState = state
  const returnTo = String(req.query.returnTo ?? '')
  req.session.oauthReturnTo =
    returnTo.startsWith('/') && !returnTo.startsWith('//')
      ? returnTo
      : config.auth.controlPlanePath

  const params = new URLSearchParams({
    client_id: config.auth.google.clientId,
    redirect_uri: config.auth.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state,
  })

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
})

app.get('/api/auth/google/callback', async (req: Request, res: Response) => {
  if (!requireGoogleConfig(res)) return

  const code = String(req.query.code ?? '')
  const state = String(req.query.state ?? '')
  const expectedState = req.session.oauthState
  const returnTo = req.session.oauthReturnTo || config.auth.controlPlanePath
  delete req.session.oauthState
  delete req.session.oauthReturnTo

  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect(buildLoginUrl(returnTo))
  }

  try {
    const tokenBody = new URLSearchParams({
      code,
      client_id: config.auth.google.clientId,
      client_secret: config.auth.google.clientSecret,
      redirect_uri: config.auth.google.redirectUri,
      grant_type: 'authorization_code',
    })

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    })

    if (!tokenResponse.ok) {
      return res.redirect(buildLoginUrl(returnTo))
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token?: string
      id_token?: string
    }
    if (!tokenPayload.access_token) {
      return res.redirect(buildLoginUrl(returnTo))
    }

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
    })
    if (!profileResponse.ok) {
      return res.redirect(buildLoginUrl(returnTo))
    }

    const profile = (await profileResponse.json()) as {
      sub: string
      email?: string
      name?: string
      picture?: string
      hd?: string
    }

    if (!profile?.sub) {
      return res.redirect(buildLoginUrl(returnTo))
    }

    if (
      config.auth.google.enforceHostedDomain &&
      profile.hd !== config.auth.google.enforceHostedDomain
    ) {
      return res.redirect(buildLoginUrl(returnTo))
    }

    req.session.user = {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    }

    req.session.save(() => {
      res.redirect(returnTo)
    })
  } catch {
    return res.redirect(buildLoginUrl(returnTo))
  }
})

app.post('/api/auth/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.clearCookie('uptime.sid')
    res.status(204).send()
  })
})

app.get('/api/health', async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT COUNT(*) AS endpoint_count FROM monitor_endpoints')

  res.json({
    status: 'ok',
    endpointCount: rows[0]?.endpoint_count ?? 0,
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/groups', async (_req: Request, res: Response) => {
  const [rows] = await pool.query(`
    SELECT
      g.*,
      COUNT(e.id) AS endpoint_count
    FROM monitor_groups g
    LEFT JOIN monitor_endpoints e ON e.group_id = g.id
    GROUP BY g.id
    ORDER BY g.name ASC
  `)

  res.json(rows)
})

app.post('/api/groups', requireEditor, async (req: Request, res: Response) => {
  const name = String(req.body.name ?? '').trim()
  const description = String(req.body.description ?? '').trim() || null

  if (!name) {
    return res.status(400).json({ error: 'Group name is required' })
  }

  const [result] = await pool.query(
    'INSERT INTO monitor_groups (name, description) VALUES (?, ?)',
    [name, description],
  )

  const [rows] = await pool.query('SELECT * FROM monitor_groups WHERE id = ?', [result.insertId])
  const createdGroup = rows[0]
  monitorEvents.emit(GROUP_CREATED_EVENT, createdGroup)
  return res.status(201).json(createdGroup)
})

app.put('/api/groups/:id', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)
  const name = String(req.body.name ?? '').trim()
  const description = String(req.body.description ?? '').trim() || null

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid group id' })
  }

  if (!name) {
    return res.status(400).json({ error: 'Group name is required' })
  }

  await pool.query('UPDATE monitor_groups SET name = ?, description = ? WHERE id = ?', [
    name,
    description,
    id,
  ])

  const [rows] = await pool.query('SELECT * FROM monitor_groups WHERE id = ?', [id])

  if (!rows.length) {
    return res.status(404).json({ error: 'Group not found' })
  }

  const updatedGroup = rows[0]
  monitorEvents.emit(GROUP_UPDATED_EVENT, updatedGroup)
  return res.json(updatedGroup)
})

app.delete('/api/groups/:id', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid group id' })
  }

  const [result] = await pool.query('DELETE FROM monitor_groups WHERE id = ?', [id])

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Group not found' })
  }

  monitorEvents.emit(GROUP_DELETED_EVENT, { id })
  return res.status(204).send()
})

app.post('/api/groups/:id/pause', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid group id' })
  }

  const [groupRows] = await pool.query('SELECT id FROM monitor_groups WHERE id = ? LIMIT 1', [id])
  if (!groupRows.length) {
    return res.status(404).json({ error: 'Group not found' })
  }

  await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        is_paused = 1,
        next_check_at = DATE_ADD(NOW(), INTERVAL interval_seconds SECOND)
      WHERE group_id = ?
    `,
    [id],
  )

  const updatedEndpoints = await getMappedEndpointsByGroupId(id)
  for (const endpoint of updatedEndpoints) {
    monitorEvents.emit(ENDPOINT_UPDATED_EVENT, endpoint)
  }

  return res.json({
    groupId: id,
    action: 'paused',
    updatedEndpoints,
  })
})

app.post('/api/groups/:id/resume', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid group id' })
  }

  const [groupRows] = await pool.query('SELECT id FROM monitor_groups WHERE id = ? LIMIT 1', [id])
  if (!groupRows.length) {
    return res.status(404).json({ error: 'Group not found' })
  }

  await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        is_paused = 0,
        next_check_at = NOW()
      WHERE group_id = ?
    `,
    [id],
  )

  const updatedEndpoints = await getMappedEndpointsByGroupId(id)
  for (const endpoint of updatedEndpoints) {
    monitorEvents.emit(ENDPOINT_UPDATED_EVENT, endpoint)
  }

  return res.json({
    groupId: id,
    action: 'resumed',
    updatedEndpoints,
  })
})

app.get('/api/endpoints', async (req: Request, res: Response) => {
  const groupId = toInteger(req.query.group_id, null)

  const params = []
  let whereClause = ''

  if (groupId != null) {
    whereClause = 'WHERE e.group_id = ?'
    params.push(groupId)
  }

  const [rows] = await pool.query(
    `
      SELECT
        e.*,
        g.name AS group_name
      FROM monitor_endpoints e
      INNER JOIN monitor_groups g ON g.id = e.group_id
      ${whereClause}
      ORDER BY g.name ASC, e.name ASC
    `,
    params,
  )

  res.json(rows.map(mapEndpointRow))
})

app.post('/api/endpoints', requireEditor, async (req: Request, res: Response) => {
  let payload

  try {
    payload = normalizeEndpointPayload(req.body)
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }

  const [groupRows] = await pool.query('SELECT id FROM monitor_groups WHERE id = ?', [payload.group_id])
  if (!groupRows.length) {
    return res.status(404).json({ error: 'Group not found' })
  }

  const [result] = await pool.query(
    `
      INSERT INTO monitor_endpoints (
        group_id,
        name,
        monitor_type,
        url,
        method,
        headers_json,
        body_text,
        expected_status,
        expected_json_path,
        expected_json_value,
        connection_json,
        probe_command,
        expected_probe_value,
        interval_seconds,
        down_retries,
        up_retries,
        next_check_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    `,
    [
      payload.group_id,
      payload.name,
      payload.monitor_type,
      payload.url,
      payload.method,
      payload.headers_json,
      payload.body_text,
      payload.expected_status,
      payload.expected_json_path,
      payload.expected_json_value,
      payload.connection_json,
      payload.probe_command,
      payload.expected_probe_value,
      payload.interval_seconds,
      payload.down_retries,
      payload.up_retries,
    ],
  )

  const [rows] = await pool.query(
    `
      SELECT
        e.*,
        g.name AS group_name
      FROM monitor_endpoints e
      INNER JOIN monitor_groups g ON g.id = e.group_id
      WHERE e.id = ?
    `,
    [result.insertId],
  )

  const createdEndpoint = mapEndpointRow(rows[0])
  monitorEvents.emit(ENDPOINT_CREATED_EVENT, createdEndpoint)
  return res.status(201).json(createdEndpoint)
})

app.put('/api/endpoints/:id', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [existingRows] = await pool.query(
    'SELECT connection_json FROM monitor_endpoints WHERE id = ? LIMIT 1',
    [id],
  )
  const existingConnection: JsonObject = existingRows.length
    ? (() => {
        const raw = existingRows[0].connection_json
        if (!raw) return {}
        if (typeof raw === 'object') return raw as JsonObject
        try {
          const parsed = JSON.parse(String(raw))
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as JsonObject)
            : {}
        } catch {
          return {}
        }
      })()
    : {}

  const incomingBody: JsonObject = { ...(req.body ?? {}) }
  if (incomingBody.connection_json != null && incomingBody.connection_json !== '') {
    try {
      const incomingConnection = parseJsonObjectInput(
        incomingBody.connection_json,
        'connection_json',
      )
      const restored = restoreMaskedJson(incomingConnection, existingConnection) as JsonObject
      incomingBody.connection_json = JSON.stringify(restored)
    } catch {
      // Leave as-is; normalizeEndpointPayload will surface the parse error.
    }
  }

  let payload
  try {
    payload = normalizeEndpointPayload(incomingBody)
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }

  const [result] = await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        group_id = ?,
        name = ?,
        monitor_type = ?,
        url = ?,
        method = ?,
        headers_json = ?,
        body_text = ?,
        expected_status = ?,
        expected_json_path = ?,
        expected_json_value = ?,
        connection_json = ?,
        probe_command = ?,
        expected_probe_value = ?,
        interval_seconds = ?,
        down_retries = ?,
        up_retries = ?,
        next_check_at = NOW()
      WHERE id = ?
    `,
    [
      payload.group_id,
      payload.name,
      payload.monitor_type,
      payload.url,
      payload.method,
      payload.headers_json,
      payload.body_text,
      payload.expected_status,
      payload.expected_json_path,
      payload.expected_json_value,
      payload.connection_json,
      payload.probe_command,
      payload.expected_probe_value,
      payload.interval_seconds,
      payload.down_retries,
      payload.up_retries,
      id,
    ],
  )

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  const [rows] = await pool.query(
    `
      SELECT
        e.*,
        g.name AS group_name
      FROM monitor_endpoints e
      INNER JOIN monitor_groups g ON g.id = e.group_id
      WHERE e.id = ?
    `,
    [id],
  )

  const updatedEndpoint = mapEndpointRow(rows[0])
  monitorEvents.emit(ENDPOINT_UPDATED_EVENT, updatedEndpoint)
  return res.json(updatedEndpoint)
})

app.delete('/api/endpoints/:id', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [result] = await pool.query('DELETE FROM monitor_endpoints WHERE id = ?', [id])

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  monitorEvents.emit(ENDPOINT_DELETED_EVENT, { id })
  return res.status(204).send()
})

app.post('/api/endpoints/:id/check', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const endpoint = await getMappedEndpointById(id)
  if (!endpoint) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  if (endpoint.is_paused) {
    return res.status(409).json({ error: 'Endpoint is paused. Resume it before checking.' })
  }

  const result = await triggerCheckNow(id)
  if (!result) {
    return res.status(500).json({ error: 'Failed to run check' })
  }

  return res.json(result)
})

app.post('/api/endpoints/:id/pause', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [result] = await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        is_paused = 1,
        next_check_at = DATE_ADD(NOW(), INTERVAL interval_seconds SECOND)
      WHERE id = ?
    `,
    [id],
  )

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  const endpoint = await getMappedEndpointById(id)
  monitorEvents.emit(ENDPOINT_UPDATED_EVENT, endpoint)
  return res.json(endpoint)
})

app.post('/api/endpoints/:id/resume', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [result] = await pool.query(
    `
      UPDATE monitor_endpoints
      SET
        is_paused = 0,
        next_check_at = NOW()
      WHERE id = ?
    `,
    [id],
  )

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  const endpoint = await getMappedEndpointById(id)
  monitorEvents.emit(ENDPOINT_UPDATED_EVENT, endpoint)
  return res.json(endpoint)
})

app.get('/api/endpoints/:id/runs', async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)
  const mode = parseStatsMode(req.query.mode)
  const granularity = parseStatsGranularity(req.query.granularity)
  const rangeDays = parseStatsRangeDays(req.query.range_days, granularity)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  if (mode === 'raw') {
    const [rows] = await pool.query(
      `
        SELECT
          id,
          status,
          response_code,
          matched_value,
          error_message,
          response_time_ms,
          checked_at
        FROM monitor_check_runs
        WHERE endpoint_id = ?
        ORDER BY checked_at DESC
        LIMIT 50
      `,
      [id],
    )

    return res.json({
      mode,
      retention_days: 90,
      points: rows,
    })
  }

  const bucketSql = getStatsBucketSql(granularity)
  const [rows] = await pool.query(
    `
      SELECT
        ${bucketSql} AS bucket_start,
        ROUND(AVG(response_time_ms)) AS avg_response_time_ms,
        COUNT(*) AS check_count,
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_count,
        MAX(checked_at) AS latest_checked_at
      FROM monitor_check_runs
      WHERE endpoint_id = ?
        AND checked_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    [id, rangeDays],
  )

  res.json({
    mode,
    granularity,
    range_days: rangeDays,
    retention_days: 90,
    points: rows,
  })
})

app.delete('/api/endpoints/:id/runs', requireEditor, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [endpointRows] = await pool.query('SELECT id FROM monitor_endpoints WHERE id = ? LIMIT 1', [id])
  if (!endpointRows.length) {
    return res.status(404).json({ error: 'Endpoint not found' })
  }

  const [result] = await pool.query('DELETE FROM monitor_check_runs WHERE endpoint_id = ?', [id])

  return res.json({
    endpointId: id,
    deletedRuns: result.affectedRows ?? 0,
  })
})

app.get('/api/crons', async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM cron_monitoring ORDER BY cron ASC')
  res.json(rows.map(mapCronRow))
})

app.post('/api/crons', requireEditor, async (req: Request, res: Response) => {
  let payload

  try {
    payload = normalizeCronPayload(req.body)
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }

  try {
    await pool.query(
      `
        INSERT INTO cron_monitoring (
          cron,
          expression,
          service,
          endpoint,
          trigger_type,
          http_method,
          start_window_seconds,
          ping_window_seconds,
          status,
          track_run
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        payload.cron,
        payload.expression,
        payload.service,
        payload.endpoint,
        payload.trigger_type,
        payload.http_method,
        payload.start_window_seconds,
        payload.ping_window_seconds,
        payload.status,
        payload.track_run,
      ],
    )
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `Cron "${payload.cron}" already exists` })
    }
    throw error
  }

  const createdCron = await getMappedCronByName(String(payload.cron))
  monitorEvents.emit(CRON_CREATED_EVENT, createdCron)
  return res.status(201).json(createdCron)
})

app.put('/api/crons/:cron', requireEditor, async (req: Request, res: Response) => {
  const cronName = String(req.params.cron ?? '').trim()

  if (!cronName) {
    return res.status(400).json({ error: 'Invalid cron name' })
  }

  let payload
  try {
    // The cron name is the primary key; renames are not supported.
    payload = normalizeCronPayload({ ...(req.body ?? {}), cron: cronName })
  } catch (error) {
    return res.status(400).json({ error: error.message })
  }

  const [result] = await pool.query(
    `
      UPDATE cron_monitoring
      SET
        expression = ?,
        service = ?,
        endpoint = ?,
        trigger_type = ?,
        http_method = ?,
        start_window_seconds = ?,
        ping_window_seconds = ?,
        status = ?,
        track_run = ?
      WHERE cron = ?
    `,
    [
      payload.expression,
      payload.service,
      payload.endpoint,
      payload.trigger_type,
      payload.http_method,
      payload.start_window_seconds,
      payload.ping_window_seconds,
      payload.status,
      payload.track_run,
      cronName,
    ],
  )

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Cron not found' })
  }

  const updatedCron = await getMappedCronByName(cronName)
  monitorEvents.emit(CRON_UPDATED_EVENT, updatedCron)
  return res.json(updatedCron)
})

app.delete('/api/crons/:cron', requireEditor, async (req: Request, res: Response) => {
  const cronName = String(req.params.cron ?? '').trim()

  if (!cronName) {
    return res.status(400).json({ error: 'Invalid cron name' })
  }

  const [result] = await pool.query('DELETE FROM cron_monitoring WHERE cron = ?', [cronName])

  if (!result.affectedRows) {
    return res.status(404).json({ error: 'Cron not found' })
  }

  monitorEvents.emit(CRON_DELETED_EVENT, { cron: cronName })
  return res.status(204).send()
})

app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  void next
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error(err)
  res.status(500).json({ error: message })
})

const distPath = path.resolve(process.cwd(), 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))

  app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

async function start() {
  await initDatabase()
  startMonitor()

  httpServer.listen(config.port, () => {
    console.log(`Express server listening on http://localhost:${config.port}`)
  })
}

start().catch((error: unknown) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})

const shutdown = async () => {
  stopMonitor()
  await new Promise<void>((resolve) => wsServer.close(() => resolve()))
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await new Promise<void>((resolve) => sessionStore.close().then(() => resolve()).catch(() => resolve()))
  await pool.end()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
