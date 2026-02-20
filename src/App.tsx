import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FaChevronDown, FaChevronRight } from 'react-icons/fa'
import { monitoringService } from './services/monitoringService'

const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const MONITOR_TYPE_OPTIONS = [
  { value: 'http', label: 'HTTP API' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'redis', label: 'Redis' },
  { value: 'nats', label: 'NATS JetStream' },
  { value: 'tcp', label: 'TCP Port' },
]

const DEFAULT_CONNECTION_JSON = {
  http: '{\n  "timeoutMs": 10000\n}',
  mysql: '{\n  "host": "127.0.0.1",\n  "port": 3306,\n  "user": "root",\n  "password": "",\n  "database": "app_db"\n}',
  redis: '{\n  "host": "127.0.0.1",\n  "port": 6379\n}',
  nats: '{\n  "servers": ["nats://127.0.0.1:4222"]\n}',
  tcp: '{\n  "host": "127.0.0.1",\n  "port": 443,\n  "timeoutMs": 5000\n}',
}

const INITIAL_ENDPOINT_FORM = {
  group_name: '',
  name: '',
  monitor_type: 'http',
  url: '',
  method: 'GET',
  headers_json: '',
  body_text: '',
  expected_status: 200,
  expected_json_path: '',
  expected_json_value: '',
  connection_json: DEFAULT_CONNECTION_JSON.http,
  probe_command: '',
  expected_probe_value: '',
  interval_seconds: 60,
  down_retries: 3,
  up_retries: 1,
}

function formatRelativeTime(input, nowMs = Date.now()) {
  if (!input) return 'never'

  // const date = moment.utc(input).local().toDate()
  const date = new Date(input)

  if (Number.isNaN(date.getTime())) return 'never'

  const deltaSeconds = Math.round((date.getTime() - nowMs) / 1000)
  const absSeconds = Math.abs(deltaSeconds)
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  if (absSeconds < 5) return 'just now'
  if (absSeconds < 60) return rtf.format(deltaSeconds, 'second')

  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, 'minute')

  const deltaHours = Math.round(deltaMinutes / 60)
  if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, 'hour')

  const deltaDays = Math.round(deltaHours / 24)
  if (Math.abs(deltaDays) < 30) return rtf.format(deltaDays, 'day')

  const deltaMonths = Math.round(deltaDays / 30)
  if (Math.abs(deltaMonths) < 12) return rtf.format(deltaMonths, 'month')

  return rtf.format(Math.round(deltaMonths / 12), 'year')
}

function stringifyJson(value, fallback = '') {
  if (value == null) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    if (!Object.keys(value).length) return fallback
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

function formatFriendlyDateTime(input) {
  if (!input) return 'Unknown time'
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return 'Unknown time'

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function getGroupStatus(endpoints) {
  if (!endpoints.length) return 'pending'
  if (endpoints.some((endpoint) => endpoint.status === 'down')) return 'down'
  if (endpoints.every((endpoint) => endpoint.status === 'up')) return 'up'
  return 'pending'
}

function LatencySparkline({ runs }) {
  const containerRef = useRef(null)
  const [hoveredPoint, setHoveredPoint] = useState(null)

  const points = useMemo(() => {
    return (runs ?? [])
      .slice(0, 24)
      .reverse()
      .map((run) => ({ latency: Number(run.response_time_ms) || 0, checkedAt: run.checked_at }))
  }, [runs])

  if (!points.length) return <p className="text-xs text-slate-500">No latency samples yet.</p>

  const width = 320
  const height = 72
  const padding = 6
  const yAxisWidth = 34
  const chartLeft = yAxisWidth + padding
  const chartRight = width - padding

  const latencies = points.map((point) => point.latency)
  const min = Math.min(...latencies)
  const max = Math.max(...latencies)
  const range = Math.max(max - min, 1)
  const xStep = points.length > 1 ? (chartRight - chartLeft) / (points.length - 1) : 0

  const tickCount = 4
  const yTicks = Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1)
    const value = Math.round(max - ratio * (max - min))
    const y = padding + ratio * (height - padding * 2)
    return { value, y }
  })

  const plottedPoints = points.map((point, index) => {
    const x = chartLeft + xStep * index
    const y = height - padding - ((point.latency - min) / range) * (height - padding * 2)
    return { ...point, x, y }
  })

  const line = plottedPoints.map((point) => `${point.x},${point.y}`).join(' ')
  const area = `${line} ${chartRight},${height - padding} ${chartLeft},${height - padding}`

  const handlePointHover = (event, point) => {
    if (!containerRef.current) return
    const containerRect = containerRef.current.getBoundingClientRect()
    const targetRect = event.currentTarget.getBoundingClientRect()

    setHoveredPoint({
      ...point,
      x: targetRect.left - containerRect.left + targetRect.width / 2,
      y: targetRect.top - containerRect.top,
    })
  }

  return (
    <div ref={containerRef} className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full overflow-visible">
        <defs>
          <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {yTicks.map((tick) => (
          <g key={tick.y}>
            <line
              x1={chartLeft}
              y1={tick.y}
              x2={chartRight}
              y2={tick.y}
              stroke="#cbd5e1"
              strokeOpacity="0.65"
              strokeWidth="1"
            />
            <text
              x={yAxisWidth - 2}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="9"
              fill="#64748b"
            >
              {tick.value}
            </text>
          </g>
        ))}
        <line x1={chartLeft} y1={padding} x2={chartLeft} y2={height - padding} stroke="#94a3b8" strokeWidth="1" />
        <polygon points={area} fill="url(#latencyFill)" />
        <polyline points={line} fill="none" stroke="#0f766e" strokeWidth="2" strokeLinecap="round" />
        {plottedPoints.map((point, index) => (
          <circle
            key={`${point.checkedAt ?? 'unknown'}-${index}`}
            cx={point.x}
            cy={point.y}
            r="3.2"
            fill="#0f766e"
            className="cursor-pointer transition hover:r-5"
            onMouseEnter={(event) => handlePointHover(event, point)}
            onMouseLeave={() => setHoveredPoint(null)}
          />
        ))}
      </svg>
      {hoveredPoint && (
        <div
          className="pointer-events-none absolute z-20 min-w-44 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-lg backdrop-blur"
          style={{
            left: `${hoveredPoint.x}px`,
            top: `${hoveredPoint.y - 10}px`,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <p className="font-semibold text-slate-900">{hoveredPoint.latency} ms</p>
          <p className="mt-0.5 text-slate-600">
            Triggered: {formatFriendlyDateTime(hoveredPoint.checkedAt)}
          </p>
        </div>
      )}
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
        <span>{min}ms min</span>
        <span>{max}ms max</span>
      </div>
    </div>
  )
}

function StatusPage({ groups, endpoints, runsByEndpoint, health, isLoading }) {
  const groupedEndpoints = useMemo(() => {
    return groups.map((group) => ({
      ...group,
      endpoints: endpoints.filter((endpoint) => endpoint.group_id === group.id),
      group_status: getGroupStatus(endpoints.filter((endpoint) => endpoint.group_id === group.id)),
    }))
  }, [groups, endpoints])

  const upCount = endpoints.filter((endpoint) => endpoint.status === 'up').length
  const downCount = endpoints.filter((endpoint) => endpoint.status === 'down').length

  const renderStatus = (endpoint) => {
    if (endpoint.is_paused) return 'bg-slate-400'
    if (endpoint.status === 'up') return 'bg-emerald-500'
    if (endpoint.status === 'down') return 'bg-rose-500'
    return 'bg-amber-500'
  }

  const renderGroupStatus = (status) => {
    if (status === 'up') return 'bg-emerald-100 text-emerald-700 border-emerald-200/80'
    if (status === 'down') return 'bg-rose-100 text-rose-700 border-rose-200/80'
    return 'bg-amber-100 text-amber-700 border-amber-200/80'
  }

  return (
    <main className="min-h-screen px-4 py-10 text-slate-900 md:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="glass-card rounded-2xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">Live Status</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Service Status Page</h1>
              <p className="mt-2 text-sm text-slate-600">Real-time health and latency of monitored services and endpoints.</p>
            </div>
            <a href="/monitors" className="rounded-lg border border-white/60 bg-white/60 px-4 py-2 text-sm font-medium text-slate-700 backdrop-blur">
              Open Admin
            </a>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
              <p className="text-xs text-slate-500">System</p>
              <p className="text-lg font-semibold">{health.status}</p>
            </div>
            <div className="rounded-xl border border-white/60 bg-white/55 p-3 backdrop-blur">
              <p className="text-xs text-slate-500">Monitors</p>
              <p className="text-lg font-semibold">{endpoints.length}</p>
            </div>
            <div className="rounded-xl border border-emerald-200/60 bg-emerald-50/70 p-3 backdrop-blur">
              <p className="text-xs text-emerald-700">Up</p>
              <p className="text-lg font-semibold text-emerald-800">{upCount}</p>
            </div>
            <div className="rounded-xl border border-rose-200/60 bg-rose-50/70 p-3 backdrop-blur">
              <p className="text-xs text-rose-700">Down</p>
              <p className="text-lg font-semibold text-rose-800">{downCount}</p>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="glass-card rounded-xl p-6 text-sm text-slate-600">Loading status...</div>
        ) : (
          <section className="space-y-6">
            {groupedEndpoints.map((group) => (
              <div key={group.id} className="glass-card rounded-2xl p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold">{group.name}</h2>
                    <p className="text-sm text-slate-500">{group.description || ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${renderGroupStatus(group.group_status)}`}>
                      {group.group_status}
                    </span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{group.endpoints.length} services</span>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  {group.endpoints.map((endpoint) => (
                    <article key={endpoint.id} className="rounded-xl border border-white/60 bg-white/55 p-4 backdrop-blur">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${renderStatus(endpoint)}`} />
                            <h3 className="font-semibold">{endpoint.name}</h3>
                            <span className="rounded bg-white/70 px-2 py-0.5 text-[10px] uppercase text-slate-600 backdrop-blur">
                              {endpoint.monitor_type}
                            </span>
                            {endpoint.is_paused ? (
                              <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                paused
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-600">{endpoint.url}</p>
                        </div>
                        <div className="text-right text-[11px] text-slate-500">
                          <p>Last code: {endpoint.last_response_code ?? 'n/a'}</p>
                          <p>Every {endpoint.interval_seconds}s</p>
                        </div>
                      </div>

                      <LatencySparkline runs={runsByEndpoint[endpoint.id] ?? []} />
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  )
}

function LandingPage() {
  return (
    <main className="min-h-screen px-4 py-12 text-slate-900 md:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <section className="glass-card rounded-2xl p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">Uptime Monitor</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
            Monitor APIs, data stores, messaging, and ports in one place
          </h1>
          <p className="mt-4 max-w-3xl text-base text-slate-600">
            Track HTTP APIs, MySQL, Redis, NATS JetStream, and TCP services with retry-aware health transitions,
            real-time updates, and latency history. Control plane access is protected with Google login.
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="/monitors"
              className="rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)]"
            >
              Open Control Plane
            </a>
            <a
              href="/status"
              className="rounded-lg border border-white/60 bg-white/70 px-5 py-2.5 text-sm font-medium text-slate-700 backdrop-blur"
            >
              Open Status Page
            </a>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="glass-card rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Control Plane</h2>
            <p className="mt-2 text-sm text-slate-600">
              Configure monitors, group services, pause/resume endpoints or entire groups, edit checks, and manage
              historical run data.
            </p>
          </article>
          <article className="glass-card rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Public Status</h2>
            <p className="mt-2 text-sm text-slate-600">
              Share a public status page with grouped health, realtime state updates, and latency trend graphs with
              hover tooltips.
            </p>
          </article>
          <article className="glass-card rounded-xl p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Secure Alerts</h2>
            <p className="mt-2 text-sm text-slate-600">
              Google-authenticated control plane, in-memory sessions, and rich Slack/webhook notifications for up/down
              events.
            </p>
          </article>
        </section>
      </div>
    </main>
  )
}

function LoginPage({ apiBase, isChecking, error }) {
  const search =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const requestedReturnTo = search.get('returnTo') || '/monitors'
  const safeReturnTo =
    requestedReturnTo.startsWith('/') && !requestedReturnTo.startsWith('//')
      ? requestedReturnTo
      : '/monitors'
  const googleAuthUrl = `${apiBase || ''}/api/auth/google?returnTo=${encodeURIComponent(safeReturnTo)}`

  return (
    <main className="min-h-screen px-4 py-12 text-slate-900 md:px-8">
      <div className="mx-auto max-w-xl">
        <section className="glass-card rounded-2xl p-8 md:p-10">
          <p className="text-xs uppercase tracking-[0.25em] text-cyan-700">Authentication</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Sign in to Control Plane</h1>
          <p className="mt-3 text-sm text-slate-600">
            Control plane access requires Google sign-in. Status page remains public.
          </p>

          <a
            href={googleAuthUrl}
            className="mt-6 inline-flex cursor-pointer items-center rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 active:scale-[0.98]"
          >
            Continue with Google
          </a>
          {isChecking ? <p className="mt-3 text-xs text-slate-500">Checking session...</p> : null}
          {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}
        </section>
      </div>
    </main>
  )
}

function AdminPage({
  health,
  groups,
  groupedEndpoints,
  endpointForm,
  editingEndpointId,
  isLoading,
  isSavingEndpoint,
  setEndpointForm,
  handleCancelEdit,
  handleDeleteHistory,
  handleEndpointSubmit,
  handleDeleteEndpoint,
  handleCheckNow,
  handleTogglePause,
  handleToggleGroupPause,
  handleStartEdit,
  currentTimeMs,
  error,
}) {
  const isHttpType = endpointForm.monitor_type === 'http'
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<number, boolean>>({})

  const filteredGroupOptions = useMemo(() => {
    const query = endpointForm.group_name.trim().toLowerCase()
    if (!query) return groups
    return groups.filter((group) => group.name.toLowerCase().includes(query))
  }, [groups, endpointForm.group_name])

  const renderStatusColor = (endpoint) => {
    if (endpoint.is_paused) return 'bg-slate-400'
    if (endpoint.status === 'up') return 'bg-emerald-500'
    if (endpoint.status === 'down') return 'bg-rose-500'
    return 'bg-amber-500'
  }

  const renderGroupStatus = (status) => {
    if (status === 'up') return 'bg-emerald-100 text-emerald-700 border-emerald-200/80'
    if (status === 'down') return 'bg-rose-100 text-rose-700 border-rose-200/80'
    return 'bg-amber-100 text-amber-700 border-amber-200/80'
  }

  return (
    <main className="min-h-screen px-4 py-8 text-slate-900 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="glass-card rounded-xl p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Monitor Service</p>
              <h1 className="mt-2 text-2xl font-semibold">Uptime Control Panel</h1>
              <p className="mt-2 text-sm text-slate-600">Configure HTTP, MySQL, and Redis monitors with retries and interval polling.</p>
            </div>
            <a href="/status" className="rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-xs font-medium backdrop-blur">Open Status Page</a>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:max-w-xl">
            <div className="rounded-lg border border-white/60 bg-white/45 p-3">
              <p className="text-slate-500">Service Status</p>
              <p className="font-semibold">{health.status}</p>
            </div>
            <div className="rounded-lg border border-white/60 bg-white/45 p-3">
              <p className="text-slate-500">Configured Monitors</p>
              <p className="font-semibold">{health.endpointCount ?? 0}</p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
          <section className="glass-card rounded-xl p-5">
            <h2 className="text-lg font-semibold">Monitored Routes</h2>
            {isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading...</p>
            ) : (
              <div className="mt-4 space-y-5">
                {!groupedEndpoints.length && <p className="text-sm text-slate-500">No groups configured yet.</p>}
                {groupedEndpoints.map((group) => (
                  <div key={group.id} className="rounded-lg border border-white/60 bg-white/40 p-4 backdrop-blur">
                    {(() => {
                      const hasMonitors = group.endpoints.length > 0
                      const allPaused = hasMonitors && group.endpoints.every((endpoint) => endpoint.is_paused)
                      return (
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-base font-semibold">{group.name}</h3>
                        <p className="text-xs text-slate-500">{group.description || ''}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleGroupPause(group)}
                          disabled={!hasMonitors}
                          className={`cursor-pointer rounded border px-3 py-1.5 text-xs text-white transition duration-150 ease-out active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 ${
                            allPaused
                              ? 'border-emerald-300/70 bg-gradient-to-r from-emerald-600 to-teal-600 shadow-[0_6px_16px_rgba(5,150,105,0.26)] hover:from-emerald-500 hover:to-teal-500 focus-visible:ring-emerald-300/80'
                              : 'border-slate-300/70 bg-gradient-to-r from-slate-600 to-slate-700 shadow-[0_6px_16px_rgba(51,65,85,0.25)] hover:from-slate-500 hover:to-slate-600 focus-visible:ring-slate-300/80'
                          } disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100`}
                        >
                          {allPaused ? 'Resume Group' : 'Pause Group'}
                        </button>
                        <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${renderGroupStatus(group.group_status)}`}>
                          {group.group_status}
                        </span>
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{group.endpoints.length} monitors</span>
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedGroups((current) => ({
                              ...current,
                              [group.id]: !(current[group.id] ?? true),
                            }))
                          }
                          aria-label={(collapsedGroups[group.id] ?? true) ? 'Expand group' : 'Collapse group'}
                          className="cursor-pointer rounded border border-slate-300/70 bg-white/70 p-2 text-slate-700 transition hover:bg-white"
                        >
                          {(collapsedGroups[group.id] ?? true) ? (
                            <FaChevronRight className="h-3 w-3" />
                          ) : (
                            <FaChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                      )
                    })()}

                    {!(collapsedGroups[group.id] ?? true) && (
                      <div className="mt-4 space-y-3">
                        {!group.endpoints.length && <p className="text-sm text-slate-500">No monitors in this group.</p>}
                        {group.endpoints.map((endpoint) => (
                          <article key={endpoint.id} className="rounded-lg border border-white/60 bg-white/50 p-3 backdrop-blur">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className={`h-2.5 w-2.5 rounded-full ${renderStatusColor(endpoint)}`} />
                                  <p className="font-medium">{endpoint.name}</p>
                                  <span className="rounded bg-white/65 px-2 py-0.5 font-mono text-xs uppercase backdrop-blur">{endpoint.monitor_type}</span>
                                  {endpoint.is_paused ? (
                                    <span className="rounded bg-slate-200/85 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-700 backdrop-blur">
                                      paused
                                    </span>
                                  ) : null}
                                </div>
                                <p className="mt-1 break-all font-mono text-xs text-slate-600">{endpoint.url}</p>
                              </div>
                              <div className="flex gap-2">
                                <button type="button" onClick={() => handleStartEdit(endpoint)} className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/80">Edit</button>
                                <button
                                  type="button"
                                  onClick={() => handleTogglePause(endpoint)}
                                  className={`cursor-pointer rounded border px-3 py-1.5 text-xs text-white transition duration-150 ease-out active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 ${
                                    endpoint.is_paused
                                      ? 'border-emerald-300/70 bg-gradient-to-r from-emerald-600 to-teal-600 shadow-[0_6px_16px_rgba(5,150,105,0.26)] hover:from-emerald-500 hover:to-teal-500 focus-visible:ring-emerald-300/80'
                                      : 'border-slate-300/70 bg-gradient-to-r from-slate-600 to-slate-700 shadow-[0_6px_16px_rgba(51,65,85,0.25)] hover:from-slate-500 hover:to-slate-600 focus-visible:ring-slate-300/80'
                                  }`}
                                >
                                  {endpoint.is_paused ? 'Resume' : 'Pause'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleCheckNow(endpoint.id)}
                                  disabled={endpoint.is_paused}
                                  className="cursor-pointer rounded border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(37,99,235,0.25)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/80 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-500 disabled:opacity-60 disabled:active:scale-100"
                                >
                                  Check now
                                </button>
                                <button type="button" onClick={() => handleDeleteHistory(endpoint.id)} className="cursor-pointer rounded border border-amber-300/70 bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(245,158,11,0.22)] transition duration-150 ease-out hover:from-amber-400 hover:to-orange-400 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/80">Delete history</button>
                                <button type="button" onClick={() => handleDeleteEndpoint(endpoint.id)} className="cursor-pointer rounded border border-rose-300/70 bg-gradient-to-r from-rose-500 to-pink-500 px-3 py-1.5 text-xs text-white shadow-[0_6px_16px_rgba(244,63,94,0.24)] transition duration-150 ease-out hover:from-rose-400 hover:to-pink-400 active:scale-[0.97] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/80">Delete</button>
                              </div>
                            </div>
                            <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                              <p>Interval: {endpoint.interval_seconds}s</p>
                              <p>Retries down/up: {endpoint.down_retries}/{endpoint.up_retries}</p>
                              <p>Last code: {endpoint.last_response_code ?? 'n/a'}</p>
                              <p>Last checked: {formatRelativeTime(endpoint.last_checked_at, currentTimeMs)}</p>
                            </div>
                            {endpoint.last_error && (
                              <p className="mt-2 rounded border border-rose-200/80 bg-rose-50/80 px-2 py-1 text-xs text-rose-700 backdrop-blur">{endpoint.last_error}</p>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-4">
            <form onSubmit={handleEndpointSubmit} className="glass-card rounded-xl p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{editingEndpointId ? 'Edit Monitor' : 'Add Monitor'}</h2>
                {editingEndpointId ? (
                  <button type="button" onClick={handleCancelEdit} className="cursor-pointer rounded border border-slate-300/70 bg-white/70 px-3 py-1.5 text-xs text-slate-700 transition duration-150 ease-out hover:bg-white active:scale-[0.97]">Cancel Edit</button>
                ) : null}
              </div>

              <label className="mt-3 block text-sm font-medium text-slate-700">
                Group (type new or choose existing)
                <div className="relative mt-1">
                  <input
                    required
                    value={endpointForm.group_name}
                    onFocus={() => setIsGroupMenuOpen(true)}
                    onBlur={() => {
                      setTimeout(() => setIsGroupMenuOpen(false), 120)
                    }}
                    onChange={(event) => {
                      setEndpointForm((current) => ({ ...current, group_name: event.target.value }))
                      setIsGroupMenuOpen(true)
                    }}
                    className="w-full rounded-lg border px-3 py-2 pr-10 text-sm focus:border-slate-500 focus:outline-none"
                    placeholder="Payments"
                  />
                  <button
                    type="button"
                    aria-label="Toggle group options"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setIsGroupMenuOpen((open) => !open)}
                    className="absolute inset-y-0 right-2 my-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      className={`h-4 w-4 transition-transform ${isGroupMenuOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {isGroupMenuOpen && filteredGroupOptions.length > 0 && (
                    <div className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-300/80 bg-white/95 p-1 shadow-lg backdrop-blur">
                      {filteredGroupOptions.map((group) => (
                        <button
                          key={group.id}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setEndpointForm((current) => ({ ...current, group_name: group.name }))
                            setIsGroupMenuOpen(false)
                          }}
                          className="block w-full cursor-pointer rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                        >
                          {group.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </label>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">
                  Name
                  <input
                    required
                    value={endpointForm.name}
                    onChange={(event) => setEndpointForm((current) => ({ ...current, name: event.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  />
                </label>
                <label className="text-sm font-medium text-slate-700">
                  Monitor Type
                  <select
                    value={endpointForm.monitor_type}
                    onChange={(event) =>
                      setEndpointForm((current) => ({
                        ...current,
                        monitor_type: event.target.value,
                        connection_json: DEFAULT_CONNECTION_JSON[event.target.value],
                      }))
                    }
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  >
                    {MONITOR_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              {isHttpType ? (
                <>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="text-sm font-medium text-slate-700">
                      Method
                      <select
                        value={endpointForm.method}
                        onChange={(event) => setEndpointForm((current) => ({ ...current, method: event.target.value }))}
                        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                      >
                        {METHOD_OPTIONS.map((method) => (
                          <option key={method} value={method}>{method}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-sm font-medium text-slate-700">
                      Expected Response Code
                      <input
                        type="number"
                        min="100"
                        max="599"
                        value={endpointForm.expected_status}
                        onChange={(event) => setEndpointForm((current) => ({ ...current, expected_status: event.target.value }))}
                        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                      />
                    </label>
                  </div>

                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Full URL Endpoint
                    <input
                      required
                      value={endpointForm.url}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, url: event.target.value }))}
                      className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                    />
                  </label>

                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Headers (JSON, optional)
                    <textarea
                      value={endpointForm.headers_json}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, headers_json: event.target.value }))}
                      className="mt-1 min-h-20 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                      placeholder='{"Authorization":"Bearer <token>"}'
                    />
                  </label>

                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Body (Optional)
                    <textarea
                      value={endpointForm.body_text}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, body_text: event.target.value }))}
                      className="mt-1 min-h-24 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                    />
                  </label>

                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className="text-sm font-medium text-slate-700">
                      JSON Path (optional)
                      <input
                        value={endpointForm.expected_json_path}
                        onChange={(event) => setEndpointForm((current) => ({ ...current, expected_json_path: event.target.value }))}
                        className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                      />
                    </label>
                    <label className="text-sm font-medium text-slate-700">
                      JSON Value (optional)
                      <input
                        value={endpointForm.expected_json_value}
                        onChange={(event) => setEndpointForm((current) => ({ ...current, expected_json_value: event.target.value }))}
                        className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                        placeholder={'"ok" or true or 123'}
                      />
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Connection Config (JSON)
                    <textarea
                      value={endpointForm.connection_json}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, connection_json: event.target.value }))}
                      className="mt-1 min-h-28 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                    />
                  </label>
                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Probe Command (optional)
                    <input
                      value={endpointForm.probe_command}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, probe_command: event.target.value }))}
                      className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                      placeholder={
                        endpointForm.monitor_type === 'mysql'
                          ? 'SELECT 1 AS health'
                          : endpointForm.monitor_type === 'redis'
                            ? 'PING or ["GET","health:key"]'
                            : endpointForm.monitor_type === 'nats'
                              ? 'jetstream.info or stream.info:ORDERS'
                              : endpointForm.monitor_type === 'tcp'
                                ? 'Optional (default checks open port)'
                                : ''
                      }
                    />
                  </label>
                  <label className="mt-3 block text-sm font-medium text-slate-700">
                    Expected Probe Value (optional)
                    <input
                      value={endpointForm.expected_probe_value}
                      onChange={(event) => setEndpointForm((current) => ({ ...current, expected_probe_value: event.target.value }))}
                      className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
                      placeholder={
                        endpointForm.monitor_type === 'mysql'
                          ? '1'
                          : endpointForm.monitor_type === 'redis'
                            ? '"PONG"'
                            : endpointForm.monitor_type === 'nats'
                              ? '"ok" or stream name'
                              : endpointForm.monitor_type === 'tcp'
                                ? '"open"'
                                : ''
                      }
                    />
                  </label>
                </>
              )}

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <label className="text-sm font-medium text-slate-700">
                  Interval (seconds)
                  <input
                    type="number"
                    min="5"
                    value={endpointForm.interval_seconds}
                    onChange={(event) => setEndpointForm((current) => ({ ...current, interval_seconds: event.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  />
                </label>
                <label className="text-sm font-medium text-slate-700">
                  Retries Before Down
                  <input
                    type="number"
                    min="1"
                    value={endpointForm.down_retries}
                    onChange={(event) => setEndpointForm((current) => ({ ...current, down_retries: event.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  />
                </label>
                <label className="text-sm font-medium text-slate-700">
                  Retries Before Up
                  <input
                    type="number"
                    min="1"
                    value={endpointForm.up_retries}
                    onChange={(event) => setEndpointForm((current) => ({ ...current, up_retries: event.target.value }))}
                    className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={isSavingEndpoint}
                className="mt-4 cursor-pointer rounded-lg border border-blue-300/60 bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition duration-150 ease-out hover:from-blue-500 hover:to-indigo-500 hover:shadow-[0_10px_28px_rgba(37,99,235,0.35)] active:scale-[0.98] active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/80 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
              >
                {isSavingEndpoint ? 'Saving...' : editingEndpointId ? 'Update Monitor' : 'Create Monitor'}
              </button>
            </form>

            {error && <p className="rounded-lg border border-rose-200/80 bg-rose-50/80 px-4 py-3 text-sm text-rose-700 backdrop-blur">{error}</p>}
          </section>
        </section>
      </div>
    </main>
  )
}

function App() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  const isHomePage = pathname === '/'
  const isStatusPage = pathname.startsWith('/status')
  const isLoginPage = pathname.startsWith('/login')
  const isMonitorsPage = pathname.startsWith('/monitors') || (!isHomePage && !isStatusPage && !isLoginPage)

  const [health, setHealth] = useState({ status: 'checking', endpointCount: 0 })
  const [groups, setGroups] = useState([])
  const [endpoints, setEndpoints] = useState([])
  const [runsByEndpoint, setRunsByEndpoint] = useState({})
  const [endpointForm, setEndpointForm] = useState(INITIAL_ENDPOINT_FORM)
  const [editingEndpointId, setEditingEndpointId] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSavingEndpoint, setIsSavingEndpoint] = useState(false)
  const [error, setError] = useState('')
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now())
  const [authChecked, setAuthChecked] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authError, setAuthError] = useState('')
  const apiBase = import.meta.env.VITE_API_BASE_URL || ''

  const groupedEndpoints = useMemo(() => {
    return groups.map((group) => ({
      ...group,
      endpoints: endpoints.filter((endpoint) => endpoint.group_id === group.id),
      group_status: getGroupStatus(endpoints.filter((endpoint) => endpoint.group_id === group.id)),
    }))
  }, [groups, endpoints])

  useEffect(() => {
    if (!isMonitorsPage && !isLoginPage) {
      setAuthChecked(true)
      return
    }

    const verifySession = async () => {
      setAuthError('')
      try {
        const sessionState = await monitoringService.getSession()
        const authenticated = Boolean(sessionState?.authenticated)
        setIsAuthenticated(authenticated)
      } catch (requestError) {
        setIsAuthenticated(false)
        setAuthError(requestError.message)
      } finally {
        setAuthChecked(true)
      }
    }

    void verifySession()
  }, [isLoginPage, isMonitorsPage])

  useEffect(() => {
    if (!isMonitorsPage) return
    if (!authChecked) return
    if (isAuthenticated) return
    const returnTo = encodeURIComponent(pathname || '/monitors')
    window.location.replace(`/login?returnTo=${returnTo}`)
  }, [authChecked, isAuthenticated, isMonitorsPage, pathname])

  const loadRuns = useCallback(async (endpointList) => {
    const runEntries = await Promise.all(
      endpointList.map(async (endpoint) => {
        try {
          const runs = await monitoringService.getEndpointRuns(endpoint.id)
          return [endpoint.id, runs]
        } catch {
          return [endpoint.id, []]
        }
      }),
    )

    setRunsByEndpoint(Object.fromEntries(runEntries))
  }, [])

  const loadData = useCallback(async () => {
    if (isHomePage || isLoginPage) {
      setIsLoading(false)
      return
    }
    if (isMonitorsPage && !isAuthenticated) {
      setIsLoading(false)
      return
    }

    setError('')
    try {
      const [healthRes, groupsRes, endpointsRes] = await Promise.all([
        monitoringService.getHealth(),
        monitoringService.getGroups(),
        monitoringService.getEndpoints(),
      ])

      setHealth(healthRes)
      setGroups(groupsRes)
      setEndpoints(endpointsRes)

      setEndpointForm((current) =>
        !current.group_name && groupsRes.length ? { ...current, group_name: groupsRes[0].name } : current,
      )

      if (isStatusPage) {
        await loadRuns(endpointsRes)
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsLoading(false)
    }
  }, [isStatusPage, loadRuns, isHomePage, isLoginPage, isMonitorsPage, isAuthenticated])

  useEffect(() => {
    if ((isMonitorsPage || isLoginPage) && !authChecked) return
    void loadData()
  }, [isStatusPage, isMonitorsPage, isLoginPage, authChecked, loadData])

  useEffect(() => {
    setHealth((current) => ({
      ...current,
      endpointCount: endpoints.length,
    }))
  }, [endpoints.length])

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTimeMs(Date.now())
    }, 30000)

    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (isHomePage || isLoginPage) return

    const toWebSocketUrl = () => {
      if (apiBase) {
        if (apiBase.startsWith('https://')) return `${apiBase.replace('https://', 'wss://')}/ws`
        if (apiBase.startsWith('http://')) return `${apiBase.replace('http://', 'ws://')}/ws`
      }

      if (typeof window !== 'undefined') {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        return `${protocol}://${window.location.host}/ws`
      }

      return ''
    }

    const wsUrl = toWebSocketUrl()
    if (!wsUrl) return

    const socket = new WebSocket(wsUrl)

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        const payload = message?.payload ?? {}

        if (message?.type === 'monitor:checked') {
          setCurrentTimeMs(Date.now())
          setEndpoints((current) =>
            current.map((endpoint) =>
              endpoint.id === payload.endpointId
                ? {
                    ...endpoint,
                    status: payload.status ?? endpoint.status,
                    last_response_code: payload.responseCode ?? endpoint.last_response_code,
                    last_checked_at: payload.lastCheckedAt ?? endpoint.last_checked_at,
                    last_error: payload.lastError ?? null,
                    last_match_value: payload.lastMatchValue ?? endpoint.last_match_value,
                    consecutive_failures:
                      payload.consecutiveFailures ?? endpoint.consecutive_failures,
                    consecutive_successes:
                      payload.consecutiveSuccesses ?? endpoint.consecutive_successes,
                  }
                : endpoint,
            ),
          )

          setRunsByEndpoint((current) => {
            const endpointId = payload.endpointId
            if (!endpointId) return current

            const existingRuns = current[endpointId] ?? []
            const nextRun = {
              response_time_ms: payload.responseTimeMs ?? 0,
              checked_at: payload.lastCheckedAt ?? new Date().toISOString(),
              response_code: payload.responseCode ?? null,
              status: payload.status ?? null,
              error_message: payload.lastError ?? null,
            }

            return {
              ...current,
              [endpointId]: [nextRun, ...existingRuns].slice(0, 50),
            }
          })
          return
        }

        if (message?.type === 'group:created' || message?.type === 'group:updated') {
          setGroups((current) => {
            const index = current.findIndex((group) => group.id === payload.id)
            if (index >= 0) {
              const next = [...current]
              next[index] = { ...next[index], ...payload }
              return next
            }
            return [...current, payload]
          })
          return
        }

        if (message?.type === 'group:deleted') {
          setGroups((current) => current.filter((group) => group.id !== payload.id))
          return
        }

        if (message?.type === 'endpoint:created' || message?.type === 'endpoint:updated') {
          setEndpoints((current) => {
            const index = current.findIndex((endpoint) => endpoint.id === payload.id)
            if (index >= 0) {
              const next = [...current]
              next[index] = { ...next[index], ...payload }
              return next
            }
            return [payload, ...current]
          })
          return
        }

        if (message?.type === 'endpoint:deleted') {
          setEndpoints((current) => current.filter((endpoint) => endpoint.id !== payload.id))
          setRunsByEndpoint((current) => {
            const next = { ...current }
            delete next[payload.id]
            return next
          })
        }
      } catch {
        // Ignore malformed websocket frames.
      }
    }

    return () => {
      socket.close()
    }
  }, [apiBase, isHomePage, isLoginPage])

  const handleEndpointSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setIsSavingEndpoint(true)

    try {
      const normalizedGroupName = endpointForm.group_name.trim()
      if (!normalizedGroupName) throw new Error('Group name is required')

      let group = groups.find((candidate) => candidate.name.toLowerCase() === normalizedGroupName.toLowerCase()) ?? null
      if (!group) {
        group = await monitoringService.createGroup({ name: normalizedGroupName, description: '' })
        setGroups((current) => {
          const index = current.findIndex((existing) => existing.id === group.id)
          if (index >= 0) {
            const next = [...current]
            next[index] = { ...next[index], ...group, endpoint_count: next[index].endpoint_count ?? 0 }
            return next
          }
          return [...current, { ...group, endpoint_count: 0 }]
        })
      }

      const payload = {
        ...endpointForm,
        group_id: Number(group.id),
        expected_status: Number(endpointForm.expected_status),
        interval_seconds: Number(endpointForm.interval_seconds),
        down_retries: Number(endpointForm.down_retries),
        up_retries: Number(endpointForm.up_retries),
      }

      if (editingEndpointId) {
        const updatedEndpoint = await monitoringService.updateEndpoint(editingEndpointId, payload)
        setEndpoints((current) =>
          current.map((endpoint) =>
            endpoint.id === editingEndpointId ? updatedEndpoint : endpoint,
          ),
        )
      } else {
        const createdEndpoint = await monitoringService.createEndpoint(payload)
        setEndpoints((current) => {
          const index = current.findIndex((endpoint) => endpoint.id === createdEndpoint.id)
          if (index >= 0) {
            const next = [...current]
            next[index] = { ...next[index], ...createdEndpoint }
            return next
          }
          return [createdEndpoint, ...current]
        })
      }

      setEndpointForm(() => ({ ...INITIAL_ENDPOINT_FORM, group_name: normalizedGroupName }))
      setEditingEndpointId(null)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setIsSavingEndpoint(false)
    }
  }

  const handleDeleteEndpoint = async (endpointId) => {
    setError('')
    try {
      await monitoringService.deleteEndpoint(endpointId)
      setEndpoints((current) => current.filter((endpoint) => endpoint.id !== endpointId))
      setRunsByEndpoint((current) => {
        const next = { ...current }
        delete next[endpointId]
        return next
      })
      if (editingEndpointId === endpointId) {
        setEditingEndpointId(null)
        setEndpointForm(() => ({ ...INITIAL_ENDPOINT_FORM, group_name: groups[0]?.name ?? '' }))
      }
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const handleDeleteHistory = async (endpointId) => {
    setError('')
    if (!window.confirm('Delete all historical check runs for this monitor?')) return

    try {
      await monitoringService.deleteEndpointRuns(endpointId)
      setRunsByEndpoint((current) => ({ ...current, [endpointId]: [] }))
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const handleStartEdit = (endpoint) => {
    const groupName = groups.find((group) => group.id === endpoint.group_id)?.name ?? endpoint.group_name ?? ''

    setEndpointForm({
      group_name: groupName,
      name: endpoint.name ?? '',
      monitor_type: endpoint.monitor_type ?? 'http',
      url: endpoint.url ?? '',
      method: endpoint.method ?? 'GET',
      headers_json: stringifyJson(endpoint.headers_json, ''),
      body_text: endpoint.body_text ?? '',
      expected_status: endpoint.expected_status ?? 200,
      expected_json_path: endpoint.expected_json_path ?? '',
      expected_json_value: endpoint.expected_json_value ?? '',
      connection_json: stringifyJson(endpoint.connection_json, DEFAULT_CONNECTION_JSON[endpoint.monitor_type] ?? '{}'),
      probe_command: endpoint.probe_command ?? '',
      expected_probe_value: endpoint.expected_probe_value ?? '',
      interval_seconds: endpoint.interval_seconds ?? 60,
      down_retries: endpoint.down_retries ?? 3,
      up_retries: endpoint.up_retries ?? 1,
    })
    setEditingEndpointId(endpoint.id)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const handleCancelEdit = () => {
    setEditingEndpointId(null)
    setEndpointForm(() => ({ ...INITIAL_ENDPOINT_FORM, group_name: groups[0]?.name ?? '' }))
  }

  const handleCheckNow = async (endpointId) => {
    setError('')
    try {
      await monitoringService.triggerCheck(endpointId)
      const optimisticNow = new Date().toISOString()
      setEndpoints((current) =>
        current.map((endpoint) =>
          endpoint.id === endpointId
            ? { ...endpoint, last_checked_at: optimisticNow }
            : endpoint,
        ),
      )
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const handleTogglePause = async (endpoint) => {
    setError('')
    try {
      const updatedEndpoint = endpoint.is_paused
        ? await monitoringService.resumeEndpoint(endpoint.id)
        : await monitoringService.pauseEndpoint(endpoint.id)

      setEndpoints((current) => {
        const index = current.findIndex((item) => item.id === updatedEndpoint.id)
        if (index >= 0) {
          const next = [...current]
          next[index] = { ...next[index], ...updatedEndpoint }
          return next
        }
        return current
      })
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const handleToggleGroupPause = async (group) => {
    setError('')
    try {
      const hasMonitors = group.endpoints.length > 0
      if (!hasMonitors) return

      const allPaused = group.endpoints.every((endpoint) => endpoint.is_paused)
      const response = allPaused
        ? await monitoringService.resumeGroup(group.id)
        : await monitoringService.pauseGroup(group.id)

      const updatedById = new Map((response.updatedEndpoints ?? []).map((endpoint) => [endpoint.id, endpoint]))
      if (!updatedById.size) return

      setEndpoints((current) =>
        current.map((endpoint) => updatedById.get(endpoint.id) ?? endpoint),
      )
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (isHomePage) {
    return <LandingPage />
  }

  if (isStatusPage) {
    return (
      <StatusPage
        groups={groups}
        endpoints={endpoints}
        runsByEndpoint={runsByEndpoint}
        health={health}
        isLoading={isLoading}
      />
    )
  }

  if (isLoginPage || (isMonitorsPage && !isAuthenticated)) {
    return <LoginPage apiBase={apiBase} isChecking={!authChecked} error={authError} />
  }

  return (
    <AdminPage
      health={health}
      groups={groups}
      groupedEndpoints={groupedEndpoints}
      endpointForm={endpointForm}
      editingEndpointId={editingEndpointId}
      isLoading={isLoading}
      isSavingEndpoint={isSavingEndpoint}
      setEndpointForm={setEndpointForm}
      handleCancelEdit={handleCancelEdit}
      handleDeleteHistory={handleDeleteHistory}
      handleEndpointSubmit={handleEndpointSubmit}
      handleDeleteEndpoint={handleDeleteEndpoint}
      handleCheckNow={handleCheckNow}
      handleTogglePause={handleTogglePause}
      handleToggleGroupPause={handleToggleGroupPause}
      handleStartEdit={handleStartEdit}
      currentTimeMs={currentTimeMs}
      error={error}
    />
  )
}

export default App
