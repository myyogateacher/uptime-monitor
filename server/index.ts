import path from 'node:path'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import cors, { type CorsOptions } from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import session from 'express-session'
import { WebSocket, WebSocketServer } from 'ws'

import { config } from './config'
import { initDatabase, pool } from './db'
import {
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

const app = express()
const httpServer = createServer(app)
const wsServer = new WebSocketServer({ server: httpServer, path: '/ws' })
const wsClients: Set<WebSocket> = new Set()

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

const toInteger = (value: unknown, fallback: number | null = null): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.trunc(parsed)
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
    connection_json: parseOrDefault(row.connection_json, {}),
  }
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

const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (isAuthenticated(req)) return next()
  return res.status(401).json({ error: 'Authentication required' })
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
    return res.status(200).json({ authenticated: false, user: null })
  }

  return res.status(200).json({
    authenticated: true,
    user: req.session.user,
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

app.post('/api/groups', requireAuth, async (req: Request, res: Response) => {
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

app.put('/api/groups/:id', requireAuth, async (req: Request, res: Response) => {
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

app.delete('/api/groups/:id', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/groups/:id/pause', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/groups/:id/resume', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/endpoints', requireAuth, async (req: Request, res: Response) => {
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

app.put('/api/endpoints/:id', requireAuth, async (req: Request, res: Response) => {
  const id = toInteger(req.params.id, NaN)

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  let payload
  try {
    payload = normalizeEndpointPayload(req.body)
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

app.delete('/api/endpoints/:id', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/endpoints/:id/check', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/endpoints/:id/pause', requireAuth, async (req: Request, res: Response) => {
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

app.post('/api/endpoints/:id/resume', requireAuth, async (req: Request, res: Response) => {
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

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Invalid endpoint id' })
  }

  const [rows] = await pool.query(
    `
      SELECT *
      FROM monitor_check_runs
      WHERE endpoint_id = ?
      ORDER BY checked_at DESC
      LIMIT 50
    `,
    [id],
  )

  res.json(rows)
})

app.delete('/api/endpoints/:id/runs', requireAuth, async (req: Request, res: Response) => {
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
  await pool.end()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
