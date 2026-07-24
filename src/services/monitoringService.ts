const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

type RequestOptions = RequestInit & {
  headers?: Record<string, string>
}

export type JsonObject = Record<string, unknown>
export type MonitorType = 'http' | 'mysql' | 'redis' | 'nats' | 'tcp'
export type MonitorStatus = 'pending' | 'up' | 'down'
export type StatsGranularity = 'minute' | 'hour' | 'day'
export type StatsMode = 'aggregate' | 'raw'
export type CronTriggerType = 'nats' | 'http'
export type CronHttpMethod = 'GET' | 'POST' | 'NONE'

export type UserRole = 'admin' | 'editor' | 'viewer'

// ---------------------------------------------------------------------------
// Infrastructure metrics (Part C). These shapes mirror the server metrics APIs
// under /api/metrics (session-authenticated). All response-shape assumptions
// live here so the integration pass has a single place to reconcile.
// ---------------------------------------------------------------------------

export type MetricKind = 'cpu' | 'memory'
export type MetricGranularity = 'minute' | 'hour' | 'day'
export type MetricAgg = 'avg' | 'sum' | 'count' | 'max' | 'p95' | 'p99'
export type AlertScope = 'node' | 'service' | 'container'
// Operator values are the exact strings the server validates and the DB enum
// stores (migration 17: ENUM('>','>=','<','<=')).
export type AlertOperator = '>' | '>=' | '<' | '<='

// GET /api/metrics/overview → nodes[] (and GET /api/metrics/nodes). Mirrors the
// server's serializeNodeOverview plus the per-node container_count.
export interface MetricNode {
  node_key: string
  hostname: string | null
  cpu_cores: number | null
  mem_total_bytes: number | null
  last_seen: string | null
  bucket_start: string | null
  cpu_pct: number | null
  cpu_pct_max: number | null
  mem_used_bytes: number | null
  mem_total_bytes_last: number | null
  mem_pct: number | null
  container_count: number
}

// GET /api/metrics/overview → services[]; also the per-node service shape from
// GET /api/metrics/nodes/:nodeKey/services (scoped to a node). Mirrors the
// server's serializeServiceOverview.
export interface MetricService {
  service_name: string
  container_count: number
  node_count: number
  cpu_pct_total: number | null
  mem_used_bytes: number | null
  total_quota_cores: number | null
  total_mem_limit_bytes: number | null
  mem_pct: number | null
  last_seen: string | null
}

export interface MetricsOverview {
  nodes: MetricNode[]
  services: MetricService[]
}

// GET /api/metrics/services/:name/containers → []. Mirrors serializeContainerRow.
export interface MetricContainer {
  container_key: string
  name: string | null
  image: string | null
  task_name: string | null
  replica_slot: number | null
  node_key: string | null
  hostname: string | null
  cpu_quota_cores: number | null
  mem_limit_bytes: number | null
  last_seen: string | null
  cpu_pct: number | null
  cpu_pct_max: number | null
  mem_used_bytes: number | null
  mem_pct: number | null
}

// A single timeseries bucket (server TimeseriesPoint). avg/max are percentages
// (node/service/container semantics differ; see route docs). avg_bytes/max_bytes
// present on memory queries; net_*_bps present on container queries.
export interface MetricTimeseriesPoint {
  bucket_start: string
  avg: number | null
  max: number | null
  avg_bytes?: number | null
  max_bytes?: number | null
  net_rx_bps?: number | null
  net_tx_bps?: number | null
}

// Subject objects carry the scope-specific reference-line data (quota/limit).
export interface MetricNodeSubject {
  node_key: string
  hostname: string | null
  cpu_cores: number | null
  mem_total_bytes: number | null
}

export interface MetricServiceSubject {
  service_name: string
  total_quota_cores: number | null
  total_mem_limit_bytes: number | null
}

export interface MetricContainerSubject {
  container_key: string
  name: string | null
  task_name: string | null
  cpu_quota_cores: number | null
  mem_limit_bytes: number | null
}

// Timeseries envelope. Exactly one of node/service/container is present,
// depending on which endpoint produced it.
export interface MetricTimeseriesResponse {
  metric: MetricKind
  granularity: MetricGranularity
  agg?: MetricAgg
  range_days: number
  // Effective window echoed by the server (ISO 8601). Present for both the
  // range_days path ([now - range_days, now)) and custom from/to windows.
  from?: string
  to?: string
  retention_days: number
  points: MetricTimeseriesPoint[]
  node?: MetricNodeSubject
  service?: MetricServiceSubject
  container?: MetricContainerSubject
}

export interface MetricAlertRule {
  id: number
  scope: AlertScope
  target_key: string | null
  metric: MetricKind
  operator: AlertOperator
  threshold_pct: number
  sustained_minutes: number
  cooldown_minutes: number
  enabled: boolean
  created_at: string
  updated_at: string
}

// Form-driven payload: numeric fields may arrive as strings from inputs.
export interface MetricAlertRuleInput {
  scope: AlertScope | string
  target_key?: string | null
  metric: MetricKind | string
  operator: AlertOperator | string
  threshold_pct: number | string
  sustained_minutes: number | string
  cooldown_minutes: number | string
  enabled: boolean
}

export interface MetricTimeseriesOptions {
  metric: MetricKind
  granularity: MetricGranularity
  rangeDays: number
  // Optional custom window (ISO 8601 datetime or YYYY-MM-DD). When both are
  // set they override rangeDays on the server.
  from?: string
  to?: string
  // Aggregation applied when re-bucketing; defaults to 'avg' server-side.
  agg?: MetricAgg
}

export interface SessionUser {
  sub: string
  email?: string
  name?: string
  picture?: string
  role?: UserRole
}

export interface SessionState {
  authenticated: boolean
  user: SessionUser | null
  canEdit: boolean
  canManageUsers: boolean
  role: UserRole | null
}

export interface AuditLogEntry {
  id: number
  actor_email: string | null
  actor_name: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string | null
  summary: string
  created_at: string
}

export interface ManagedUser {
  id: number
  email: string
  name: string | null
  picture: string | null
  role: UserRole
  effective_role: UserRole
  is_banned: boolean
  is_allowlisted: boolean
  is_self: boolean
  last_login_at: string | null
  created_at: string | null
}

export interface HealthState {
  status: string
  endpointCount: number
  cronCount: number
  timestamp: string
}

export interface MonitorGroup {
  id: number
  name: string
  description: string | null
  created_at: string
  updated_at: string
  // Present on GET /api/groups; absent on the create-group response.
  endpoint_count?: number
}

export interface MonitorEndpoint {
  id: number
  group_id: number
  group_name: string
  name: string
  monitor_type: MonitorType
  url: string
  method: string
  headers_json: JsonObject
  body_text: string | null
  expected_status: number
  expected_json_path: string | null
  expected_json_value: string | null
  connection_json: JsonObject
  probe_command: string | null
  expected_probe_value: string | null
  interval_seconds: number
  down_retries: number
  up_retries: number
  status: MonitorStatus
  consecutive_failures: number
  consecutive_successes: number
  last_checked_at: string | null
  last_response_code: number | null
  last_error: string | null
  last_match_value: string | null
  is_paused: boolean
  next_check_at: string
  created_at: string
  updated_at: string
}

export interface GroupPauseResult {
  groupId: number
  action: 'paused' | 'resumed'
  updatedEndpoints: MonitorEndpoint[]
}

export interface EndpointCheckResult {
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

export interface EndpointCheckRun {
  id: number
  status: MonitorStatus
  response_code: number | null
  matched_value: string | null
  error_message: string | null
  response_time_ms: number | null
  checked_at: string
}

export interface EndpointStatsBucket {
  bucket_start: string
  avg_response_time_ms: number | null
  check_count: number
  up_count: number
  down_count: number
  latest_checked_at: string | null
}

export interface EndpointRunsRawResponse {
  mode: 'raw'
  retention_days: number
  points: EndpointCheckRun[]
}

export interface EndpointRunsAggregateResponse {
  mode: 'aggregate'
  granularity: StatsGranularity
  range_days: number
  retention_days: number
  points: EndpointStatsBucket[]
}

export type EndpointRunsResponse = EndpointRunsRawResponse | EndpointRunsAggregateResponse

export interface DeleteEndpointRunsResult {
  endpointId: number
  deletedRuns: number
}

export interface CronJob {
  cron: string
  expression: string
  service: string
  endpoint: string
  trigger_type: CronTriggerType
  http_method: CronHttpMethod
  headers_json: JsonObject
  body_text: string | null
  nats_subject: string
  start_window_seconds: number
  ping_window_seconds: number
  status: boolean
  track_run: boolean
  next_run_at: string | null
  created_date: string
  modified_date: string
  // Present on GET /api/crons (joined from the latest cron run).
  last_run_status?: string | null
  last_run_at?: string | null
  last_run_error?: string | null
}

export interface CronRun {
  id: number
  run_id: string
  cron: string
  trigger_type: CronTriggerType
  status: string
  triggered_at: string
  deadline_at: string | null
  first_ping_at: string | null
  last_ping_at: string | null
  completed_at: string | null
  pings: number
  duration_ms: number | null
  response_code: number | null
  error_message: string | null
  created_at: string
}

export interface CronMonitorSettings {
  enabled: boolean
  updatedBy: string | null
  updatedAt: string | null
}

export interface GroupInput {
  name: string
  description?: string | null
}

// Form-driven payloads: numeric fields may arrive as strings and JSON fields
// as raw textarea text; the server normalizes and validates them.
export interface EndpointInput {
  name: string
  monitor_type: MonitorType | string
  group_id: number | string
  interval_seconds: number | string
  down_retries: number | string
  up_retries: number | string
  url?: string
  method?: string
  headers_json?: string | JsonObject | null
  body_text?: string | null
  expected_status?: number | string
  expected_json_path?: string | null
  expected_json_value?: string | null
  connection_json?: string | JsonObject | null
  probe_command?: string | null
  expected_probe_value?: string | null
}

export interface CronInput {
  cron: string
  expression: string
  service?: string
  endpoint?: string
  trigger_type?: CronTriggerType | string
  http_method?: CronHttpMethod | string
  headers_json?: string | JsonObject | null
  body_text?: string | null
  nats_subject?: string
  start_window_seconds?: number | string
  ping_window_seconds?: number | string
  status?: number | boolean
  track_run?: number | boolean
}

type EndpointRunsOptions = {
  mode?: StatsMode
  granularity?: StatsGranularity
  rangeDays?: number
}

type CronRunsOptions = {
  limit?: number
  rangeDays?: number
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  })

  if (response.status === 204) return null as T

  const payload: unknown = await response.json().catch(() => ({}))

  if (!response.ok) {
    const message = (payload as { error?: string }).error
    throw new Error(message || `Request failed with status ${response.status}`)
  }

  return payload as T
}

export const monitoringService = {
  getSession(): Promise<SessionState> {
    return request<SessionState>('/api/auth/me')
  },
  logout(): Promise<null> {
    return request<null>('/api/auth/logout', {
      method: 'POST',
    })
  },
  getUsers(): Promise<ManagedUser[]> {
    return request<ManagedUser[]>('/api/users')
  },
  createUser(email: string, role: UserRole): Promise<ManagedUser> {
    return request<ManagedUser>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    })
  },
  setUserRole(userId: number, role: UserRole): Promise<ManagedUser> {
    return request<ManagedUser>(`/api/users/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    })
  },
  setUserBanned(userId: number, banned: boolean): Promise<ManagedUser> {
    return request<ManagedUser>(`/api/users/${userId}/ban`, {
      method: 'PATCH',
      body: JSON.stringify({ banned }),
    })
  },
  getAuditLogs(limit = 200): Promise<AuditLogEntry[]> {
    return request<AuditLogEntry[]>(`/api/audit-logs?limit=${limit}`)
  },
  truncateAuditLogs(period: string): Promise<{ deleted: number }> {
    return request<{ deleted: number }>(
      `/api/audit-logs?period=${encodeURIComponent(period)}`,
      { method: 'DELETE' },
    )
  },
  getHealth(): Promise<HealthState> {
    return request<HealthState>('/api/health')
  },
  getGroups(): Promise<MonitorGroup[]> {
    return request<MonitorGroup[]>('/api/groups')
  },
  createGroup(input: GroupInput): Promise<MonitorGroup> {
    return request<MonitorGroup>('/api/groups', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  pauseGroup(groupId: number): Promise<GroupPauseResult> {
    return request<GroupPauseResult>(`/api/groups/${groupId}/pause`, {
      method: 'POST',
    })
  },
  resumeGroup(groupId: number): Promise<GroupPauseResult> {
    return request<GroupPauseResult>(`/api/groups/${groupId}/resume`, {
      method: 'POST',
    })
  },
  getEndpoints(): Promise<MonitorEndpoint[]> {
    return request<MonitorEndpoint[]>('/api/endpoints')
  },
  createEndpoint(input: EndpointInput): Promise<MonitorEndpoint> {
    return request<MonitorEndpoint>('/api/endpoints', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateEndpoint(endpointId: number, input: EndpointInput): Promise<MonitorEndpoint> {
    return request<MonitorEndpoint>(`/api/endpoints/${endpointId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  triggerCheck(endpointId: number): Promise<EndpointCheckResult> {
    return request<EndpointCheckResult>(`/api/endpoints/${endpointId}/check`, {
      method: 'POST',
    })
  },
  pauseEndpoint(endpointId: number): Promise<MonitorEndpoint> {
    return request<MonitorEndpoint>(`/api/endpoints/${endpointId}/pause`, {
      method: 'POST',
    })
  },
  resumeEndpoint(endpointId: number): Promise<MonitorEndpoint> {
    return request<MonitorEndpoint>(`/api/endpoints/${endpointId}/resume`, {
      method: 'POST',
    })
  },
  getEndpointRuns(
    endpointId: number,
    options: EndpointRunsOptions = {},
  ): Promise<EndpointRunsResponse> {
    const params = new URLSearchParams()

    if (options.granularity) {
      params.set('granularity', options.granularity)
    }

    if (options.mode) {
      params.set('mode', options.mode)
    }

    if (options.rangeDays) {
      params.set('range_days', String(options.rangeDays))
    }

    const query = params.toString()
    return request<EndpointRunsResponse>(
      `/api/endpoints/${endpointId}/runs${query ? `?${query}` : ''}`,
    )
  },
  deleteEndpoint(endpointId: number): Promise<null> {
    return request<null>(`/api/endpoints/${endpointId}`, {
      method: 'DELETE',
    })
  },
  deleteEndpointRuns(endpointId: number): Promise<DeleteEndpointRunsResult> {
    return request<DeleteEndpointRunsResult>(`/api/endpoints/${endpointId}/runs`, {
      method: 'DELETE',
    })
  },
  getCrons(): Promise<CronJob[]> {
    return request<CronJob[]>('/api/crons')
  },
  createCron(input: CronInput): Promise<CronJob> {
    return request<CronJob>('/api/crons', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateCron(cronName: string, input: CronInput): Promise<CronJob> {
    return request<CronJob>(`/api/crons/${encodeURIComponent(cronName)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  deleteCron(cronName: string): Promise<null> {
    return request<null>(`/api/crons/${encodeURIComponent(cronName)}`, {
      method: 'DELETE',
    })
  },
  getCronSettings(): Promise<CronMonitorSettings> {
    return request<CronMonitorSettings>('/api/crons/settings')
  },
  updateCronSettings(input: { enabled: boolean }): Promise<CronMonitorSettings> {
    return request<CronMonitorSettings>('/api/crons/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  getCronRuns(cronName: string, options: CronRunsOptions = {}): Promise<CronRun[]> {
    const params = new URLSearchParams()
    if (options.limit) params.set('limit', String(options.limit))
    if (options.rangeDays) params.set('range_days', String(options.rangeDays))
    const query = params.toString()
    return request<CronRun[]>(
      `/api/crons/${encodeURIComponent(cronName)}/runs${query ? `?${query}` : ''}`,
    )
  },

  // ---- Infrastructure metrics ------------------------------------------
  getMetricsOverview(): Promise<MetricsOverview> {
    return request<MetricsOverview>('/api/metrics/overview')
  },
  getMetricNodes(): Promise<MetricNode[]> {
    return request<MetricNode[]>('/api/metrics/nodes')
  },
  getNodeServices(nodeKey: string): Promise<MetricService[]> {
    return request<MetricService[]>(
      `/api/metrics/nodes/${encodeURIComponent(nodeKey)}/services`,
    )
  },
  getServiceContainers(serviceName: string): Promise<MetricContainer[]> {
    return request<MetricContainer[]>(
      `/api/metrics/services/${encodeURIComponent(serviceName)}/containers`,
    )
  },
  getNodeTimeseries(
    nodeKey: string,
    options: MetricTimeseriesOptions,
  ): Promise<MetricTimeseriesResponse> {
    return request<MetricTimeseriesResponse>(
      `/api/metrics/nodes/${encodeURIComponent(nodeKey)}/timeseries${metricsQuery(options)}`,
    )
  },
  getServiceTimeseries(
    serviceName: string,
    options: MetricTimeseriesOptions,
  ): Promise<MetricTimeseriesResponse> {
    return request<MetricTimeseriesResponse>(
      `/api/metrics/services/${encodeURIComponent(serviceName)}/timeseries${metricsQuery(options)}`,
    )
  },
  getContainerTimeseries(
    containerKey: string,
    options: MetricTimeseriesOptions,
  ): Promise<MetricTimeseriesResponse> {
    return request<MetricTimeseriesResponse>(
      `/api/metrics/containers/${encodeURIComponent(containerKey)}/timeseries${metricsQuery(options)}`,
    )
  },
  getAlertRules(): Promise<MetricAlertRule[]> {
    return request<MetricAlertRule[]>('/api/metrics/alert-rules')
  },
  createAlertRule(input: MetricAlertRuleInput): Promise<MetricAlertRule> {
    return request<MetricAlertRule>('/api/metrics/alert-rules', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateAlertRule(id: number, input: MetricAlertRuleInput): Promise<MetricAlertRule> {
    return request<MetricAlertRule>(`/api/metrics/alert-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  deleteAlertRule(id: number): Promise<null> {
    return request<null>(`/api/metrics/alert-rules/${id}`, {
      method: 'DELETE',
    })
  },
}

function metricsQuery(options: MetricTimeseriesOptions): string {
  const params = new URLSearchParams()
  params.set('metric', options.metric)
  params.set('granularity', options.granularity)
  if (options.agg) {
    params.set('agg', options.agg)
  }
  if (options.from && options.to) {
    // Custom window overrides range_days server-side.
    params.set('from', options.from)
    params.set('to', options.to)
  } else {
    params.set('range_days', String(options.rangeDays))
  }
  return `?${params.toString()}`
}
