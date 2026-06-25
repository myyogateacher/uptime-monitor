import dotenv from 'dotenv'

dotenv.config()

type NotificationEvent = 'up' | 'down'

type SlackTarget = {
  name: string
  type: 'slack'
  token: string
  channel: string
  events: NotificationEvent[]
  headers: Record<string, string>
}

type WebhookTarget = {
  name: string
  type: 'webhook'
  url: string
  events: NotificationEvent[]
  headers: Record<string, string>
}

export type NotificationTarget = SlackTarget | WebhookTarget

export type NatsClientConfig = {
  servers: string[]
  user: string | undefined
  pass: string | undefined
  token: string | undefined
}

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const toBoolean = (value: unknown, fallback = false): boolean => {
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

const parseJson = <T>(value: string | undefined, fallback: T): T => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const normalizeNotificationTarget = (target: Record<string, any> | null): NotificationTarget | null => {
  if (!target || typeof target !== 'object') return null

  const type = String(target.type ?? 'webhook').trim().toLowerCase()

  const events = Array.isArray(target.events)
    ? target.events
        .map((event) => String(event).trim().toLowerCase())
        .filter((event): event is NotificationEvent => event === 'up' || event === 'down')
    : null

  const headers =
    target.headers && typeof target.headers === 'object' && !Array.isArray(target.headers)
      ? target.headers
      : {}

  if (type === 'slack') {
    const token = String(target.token ?? '').trim()
    const channel = String(target.channel ?? '').trim()
    if (!token || !channel) return null

    return {
      name: String(target.name ?? 'slack-target').trim(),
      type: 'slack',
      token,
      channel,
      events: events && events.length ? events : ['up', 'down'],
      headers: {},
    }
  }

  const url = String(target.url ?? '').trim()
  if (!url) return null

  return {
    name: String(target.name ?? `${type}-target`).trim(),
    type: 'webhook',
    url,
    events: events && events.length ? events : ['up', 'down'],
    headers,
  }
}

const parseNotificationTargets = (): NotificationTarget[] => {
  const fromJson = parseJson(process.env.NOTIFICATION_TARGETS_JSON, [])
  const jsonTargets = Array.isArray(fromJson)
    ? fromJson
        .map(normalizeNotificationTarget)
        .filter((target): target is NotificationTarget => Boolean(target))
    : []

  const slackToken = String(process.env.SLACK_BOT_TOKEN ?? '').trim()
  const slackChannel = String(process.env.SLACK_CHANNEL_ID ?? '').trim()
  if (!slackToken || !slackChannel) return jsonTargets

  const hasSlackTarget = jsonTargets.some(
    (target) =>
      target.type === 'slack' &&
      target.channel === slackChannel &&
      target.token === slackToken,
  )
  if (hasSlackTarget) return jsonTargets

  return [
    ...jsonTargets,
    {
      name: 'slack-default',
      type: 'slack',
      token: slackToken,
      channel: slackChannel,
      events: ['up', 'down'],
      headers: {},
    },
  ]
}

const parseLagThresholds = (rawValue: string | undefined): Record<string, number> => {
  const parsed = parseJson(rawValue, {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const thresholds: Record<string, number> = {}
  for (const [name, value] of Object.entries(parsed)) {
    const threshold = Number(value)
    if (Number.isFinite(threshold) && threshold >= 0) thresholds[name] = threshold
  }
  return thresholds
}

const parseNatsClient = (rawValue: string | undefined): NatsClientConfig | null => {
  const parsed = parseJson<Record<string, any> | null>(rawValue, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const address = String(parsed.address ?? '').trim()
  if (!address) return null

  const servers = address.startsWith('nats://') ? [address] : [`nats://${address}`]
  const user = String(parsed.username ?? parsed.user ?? '').trim()
  const pass = String(parsed.password ?? parsed.pass ?? '').trim()
  const token = String(parsed.token ?? '').trim()

  return {
    servers,
    user: user || undefined,
    pass: pass || undefined,
    token: token || undefined,
  }
}

const parseEmailAllowlist = (rawValue: string | undefined): string[] =>
  String(rawValue ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

const nodeEnv = process.env.NODE_ENV ?? 'development'

export const config = {
  nodeEnv,
  port: toNumber(process.env.PORT, 3001),
  monitorPollMs: toNumber(process.env.MONITOR_POLL_MS, 1000),
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 10000),
  natsLagThresholds: parseLagThresholds(process.env.NATS_LAG_THRESHOLDS),
  nats: parseNatsClient(process.env.NATS_CLIENT),
  cron: {
    pollMs: toNumber(process.env.CRON_POLL_MS, 1000),
    sweepIntervalMs: toNumber(process.env.CRON_SWEEP_INTERVAL_MS, 30000),
    catchupGraceMs: toNumber(process.env.CRON_CATCHUP_GRACE_MS, 120000),
    notifyToken: String(process.env.CRON_NOTIFY_TOKEN ?? '').trim(),
    runRetentionDays: toNumber(process.env.CRON_RUN_RETENTION_DAYS, 90),
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  mysql: {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: toNumber(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? 'uptime_monitor',
    connectionLimit: toNumber(process.env.MYSQL_CONNECTION_LIMIT, 10),
  },
  notifications: {
    enabled: String(process.env.NOTIFICATIONS_ENABLED ?? 'true').toLowerCase() !== 'false',
    targets: parseNotificationTargets(),
  },
  auth: {
    sessionSecret: process.env.SESSION_SECRET ?? 'change-me',
    sessionMaxAgeMs: toNumber(process.env.SESSION_MAX_AGE_MS, 1000 * 60 * 60 * 24),
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: process.env.GOOGLE_REDIRECT_URI ?? '',
      enforceHostedDomain: process.env.GOOGLE_HOSTED_DOMAIN ?? '',
    },
    controlPlanePath: process.env.CONTROL_PLANE_PATH ?? '/monitors',
    loginPath: process.env.LOGIN_PATH ?? '/login',
    trustProxy: toBoolean(process.env.TRUST_PROXY, nodeEnv === 'production'),
    adminEmails: parseEmailAllowlist(process.env.CONTROL_PLANE_ADMIN_EMAILS),
  },
}
