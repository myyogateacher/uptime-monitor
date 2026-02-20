import dotenv from 'dotenv'

dotenv.config()

const toNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const parseJson = (value, fallback) => {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const normalizeNotificationTarget = (target) => {
  if (!target || typeof target !== 'object') return null

  const type = String(target.type ?? 'webhook').trim().toLowerCase()

  const events = Array.isArray(target.events)
    ? target.events
        .map((event) => String(event).trim().toLowerCase())
        .filter((event) => event === 'up' || event === 'down')
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

const parseNotificationTargets = () => {
  const fromJson = parseJson(process.env.NOTIFICATION_TARGETS_JSON, [])
  const jsonTargets = Array.isArray(fromJson) ? fromJson.map(normalizeNotificationTarget).filter(Boolean) : []

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

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: toNumber(process.env.PORT, 3001),
  monitorPollMs: toNumber(process.env.MONITOR_POLL_MS, 1000),
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 10000),
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
}
