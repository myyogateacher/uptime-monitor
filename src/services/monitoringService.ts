const API_BASE = import.meta.env.VITE_API_BASE_URL || ''

type RequestOptions = RequestInit & {
  headers?: Record<string, string>
}

async function request(path: string, options: RequestOptions = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  })

  if (response.status === 204) return null

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`)
  }

  return payload
}

export const monitoringService = {
  getHealth() {
    return request('/api/health')
  },
  getGroups() {
    return request('/api/groups')
  },
  createGroup(input) {
    return request('/api/groups', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  pauseGroup(groupId) {
    return request(`/api/groups/${groupId}/pause`, {
      method: 'POST',
    })
  },
  resumeGroup(groupId) {
    return request(`/api/groups/${groupId}/resume`, {
      method: 'POST',
    })
  },
  getEndpoints() {
    return request('/api/endpoints')
  },
  createEndpoint(input) {
    return request('/api/endpoints', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  updateEndpoint(endpointId, input) {
    return request(`/api/endpoints/${endpointId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
  triggerCheck(endpointId) {
    return request(`/api/endpoints/${endpointId}/check`, {
      method: 'POST',
    })
  },
  pauseEndpoint(endpointId) {
    return request(`/api/endpoints/${endpointId}/pause`, {
      method: 'POST',
    })
  },
  resumeEndpoint(endpointId) {
    return request(`/api/endpoints/${endpointId}/resume`, {
      method: 'POST',
    })
  },
  getEndpointRuns(endpointId) {
    return request(`/api/endpoints/${endpointId}/runs`)
  },
  deleteEndpoint(endpointId) {
    return request(`/api/endpoints/${endpointId}`, {
      method: 'DELETE',
    })
  },
  deleteEndpointRuns(endpointId) {
    return request(`/api/endpoints/${endpointId}/runs`, {
      method: 'DELETE',
    })
  },
}
