// Docker Engine API client over the unix socket, using Bun's `fetch` `unix`
// option. No HTTP client dependency — the host in the URL is a placeholder
// (`localhost`); the `unix` option routes the connection to the socket.

import { config, log } from './config'

// ---- Engine API response shapes (only the fields we consume) --------------

export interface DockerInfo {
  ID: string
  Name: string
  NCPU: number
  Swarm?: { NodeID?: string }
}

export interface ContainerListItem {
  Id: string
  Names: string[]
  Image: string
  Labels: Record<string, string> | null
}

export interface CpuUsage {
  total_usage?: number
  percpu_usage?: number[] | null
}

export interface CpuStats {
  cpu_usage?: CpuUsage
  system_cpu_usage?: number
  online_cpus?: number
}

export interface MemoryStats {
  usage?: number
  limit?: number
  stats?: Record<string, number>
}

export interface NetworkStats {
  rx_bytes?: number
  tx_bytes?: number
}

export interface ContainerStats {
  cpu_stats?: CpuStats
  precpu_stats?: CpuStats
  memory_stats?: MemoryStats
  networks?: Record<string, NetworkStats> | null
}

export interface ContainerInspect {
  Id: string
  Name: string
  HostConfig?: {
    NanoCpus?: number
    CpuQuota?: number
    CpuPeriod?: number
    Memory?: number
  }
}

const base = `http://localhost/${config.dockerApiVersion}`

const dockerFetch = async (path: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(`${base}${path}`, {
      unix: config.dockerSocket,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

const getJson = async <T>(path: string, timeoutMs = config.httpTimeoutMs): Promise<T> => {
  const res = await dockerFetch(path, timeoutMs)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`docker GET ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export const getInfo = (): Promise<DockerInfo> => getJson<DockerInfo>('/info')

export const listRunningContainers = (): Promise<ContainerListItem[]> =>
  getJson<ContainerListItem[]>('/containers/json')

// stream=false makes the daemon return a single snapshot with populated
// precpu_stats, so no per-container CPU state has to be kept between ticks.
export const getContainerStats = (id: string): Promise<ContainerStats> =>
  getJson<ContainerStats>(`/containers/${id}/stats?stream=false`)

export const inspectContainer = (id: string): Promise<ContainerInspect> =>
  getJson<ContainerInspect>(`/containers/${id}/json`)

// Run promise-returning tasks with a bounded concurrency. Rejections are
// surfaced to the caller as rejected settled results (never thrown here).
export const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ item: T; value: R } | { item: T; error: unknown }>> => {
  const results: Array<{ item: T; value: R } | { item: T; error: unknown }> = []
  let cursor = 0

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]!
      try {
        results[index] = { item, value: await worker(item) }
      } catch (error) {
        results[index] = { item, error }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner())
  await Promise.all(workers)
  return results
}

// ---- Cached node identity (/info) -----------------------------------------

let cachedInfo: DockerInfo | null = null
let cachedInfoAt = 0

export const getNodeInfo = async (force = false): Promise<DockerInfo> => {
  const now = Date.now()
  if (!force && cachedInfo && now - cachedInfoAt < config.infoRefreshMs) {
    return cachedInfo
  }
  try {
    cachedInfo = await getInfo()
    cachedInfoAt = now
  } catch (err) {
    if (cachedInfo) {
      log.warn('docker /info refresh failed, using cached identity', { error: String(err) })
      return cachedInfo
    }
    throw err
  }
  return cachedInfo
}

// ---- Cached container inspects (quota/limit change rarely) -----------------

interface InspectCacheEntry {
  at: number
  data: ContainerInspect
}

const inspectCache = new Map<string, InspectCacheEntry>()

export const getInspectCached = async (id: string): Promise<ContainerInspect | null> => {
  const now = Date.now()
  const hit = inspectCache.get(id)
  if (hit && now - hit.at < config.inspectCacheMs) return hit.data
  try {
    const data = await inspectContainer(id)
    inspectCache.set(id, { at: now, data })
    return data
  } catch (err) {
    log.debug('container inspect failed', { id: id.slice(0, 12), error: String(err) })
    return hit ? hit.data : null
  }
}

// Drop inspect-cache entries for containers that are no longer running so the
// map does not grow unbounded across the process lifetime.
export const pruneInspectCache = (liveIds: Set<string>): void => {
  for (const id of inspectCache.keys()) {
    if (!liveIds.has(id)) inspectCache.delete(id)
  }
}
