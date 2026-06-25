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
}
