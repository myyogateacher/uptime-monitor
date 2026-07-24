// Pure transforms from Docker Engine API shapes into the wire contract
// (types.ts). All the docker-stats CPU/mem/net math lives here.

import { COLLECTOR_VERSION, config, log } from './config'
import {
  getContainerStats,
  getInspectCached,
  getNodeInfo,
  listRunningContainers,
  mapWithConcurrency,
  pruneInspectCache,
  type ContainerInspect,
  type ContainerListItem,
  type ContainerStats,
  type DockerInfo,
} from './docker'
import { readHostSample } from './host'
import {
  SCHEMA_VERSION,
  type ContainerMetrics,
  type MetricsIngestPayload,
  type NodeInfo,
} from './types'

const LABEL_SERVICE = 'com.docker.swarm.service.name'
const LABEL_TASK = 'com.docker.swarm.task.name'
const LABEL_STACK = 'com.docker.stack.namespace'

// docker-stats CPU%: 100 == one full core. Returns 0 for the guarded edge
// cases (zeroed precpu, non-positive system delta), clamps to [0, cores*100].
export const computeCpuPct = (stats: ContainerStats): number => {
  const cpu = stats.cpu_stats
  const precpu = stats.precpu_stats
  if (!cpu?.cpu_usage || !precpu?.cpu_usage) return 0

  const cpuTotal = cpu.cpu_usage.total_usage ?? 0
  const preCpuTotal = precpu.cpu_usage.total_usage ?? 0
  const systemTotal = cpu.system_cpu_usage ?? 0
  const preSystemTotal = precpu.system_cpu_usage ?? 0

  // Zeroed precpu => first sample the daemon ever took; no baseline.
  if (preCpuTotal === 0 || preSystemTotal === 0) return 0

  const cpuDelta = cpuTotal - preCpuTotal
  const systemDelta = systemTotal - preSystemTotal
  if (systemDelta <= 0 || cpuDelta <= 0) return 0

  const onlineCpus =
    cpu.online_cpus && cpu.online_cpus > 0
      ? cpu.online_cpus
      : (cpu.cpu_usage.percpu_usage?.length ?? 1)

  const pct = (cpuDelta / systemDelta) * onlineCpus * 100
  return Math.min(onlineCpus * 100, Math.max(0, pct))
}

// Memory actually used: total usage minus reclaimable page cache. cgroup v2
// exposes inactive_file; v1 exposes cache.
export const computeMemUsed = (stats: ContainerStats): number => {
  const mem = stats.memory_stats
  if (!mem) return 0
  const usage = mem.usage ?? 0
  const inactive = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0
  return Math.max(0, usage - inactive)
}

// Effective memory limit, or null when unlimited (≈ host total within 1%).
export const computeMemLimit = (
  stats: ContainerStats,
  inspect: ContainerInspect | null,
  hostTotalBytes: number,
): number | null => {
  const inspectLimit = inspect?.HostConfig?.Memory
  const statsLimit = stats.memory_stats?.limit
  const limit =
    inspectLimit && inspectLimit > 0 ? inspectLimit : statsLimit && statsLimit > 0 ? statsLimit : 0
  if (limit <= 0) return null
  if (hostTotalBytes > 0 && Math.abs(limit - hostTotalBytes) <= hostTotalBytes * 0.01) return null
  return limit
}

// Allotted CPU cores: NanoCpus first, then CpuQuota/CpuPeriod, else unlimited.
export const computeQuotaCores = (inspect: ContainerInspect | null): number | null => {
  const hc = inspect?.HostConfig
  if (!hc) return null
  if (hc.NanoCpus && hc.NanoCpus > 0) return hc.NanoCpus / 1e9
  if (hc.CpuQuota && hc.CpuQuota > 0 && hc.CpuPeriod && hc.CpuPeriod > 0) {
    return hc.CpuQuota / hc.CpuPeriod
  }
  return null
}

export const sumNetwork = (stats: ContainerStats): { rx: number; tx: number } => {
  let rx = 0
  let tx = 0
  const networks = stats.networks
  if (networks) {
    for (const iface of Object.values(networks)) {
      rx += iface.rx_bytes ?? 0
      tx += iface.tx_bytes ?? 0
    }
  }
  return { rx, tx }
}

// Parse the replica slot out of a swarm task name: service.SLOT.taskid.
// Global-mode tasks have no numeric slot (service.<nodeid>.taskid) -> null.
export const parseReplicaSlot = (taskName: string | null): number | null => {
  if (!taskName) return null
  const parts = taskName.split('.')
  if (parts.length < 2) return null
  const slot = Number(parts[1])
  return Number.isInteger(slot) && slot > 0 ? slot : null
}

const cleanName = (names: string[] | undefined): string => {
  const raw = names && names.length ? names[0]! : ''
  return raw.startsWith('/') ? raw.slice(1) : raw
}

const buildContainerMetrics = (
  container: ContainerListItem,
  stats: ContainerStats,
  inspect: ContainerInspect | null,
  hostTotalBytes: number,
): ContainerMetrics => {
  const labels = container.Labels ?? {}
  const serviceName = labels[LABEL_SERVICE] ?? null
  const taskName = labels[LABEL_TASK] ?? null
  const stackNamespace = labels[LABEL_STACK] ?? null
  const net = sumNetwork(stats)

  return {
    container_id: container.Id,
    name: cleanName(container.Names),
    image: container.Image,
    service_name: serviceName,
    task_name: taskName,
    replica_slot: parseReplicaSlot(taskName),
    stack_namespace: stackNamespace,
    cpu_pct: computeCpuPct(stats),
    cpu_quota_cores: computeQuotaCores(inspect),
    mem_used_bytes: computeMemUsed(stats),
    mem_limit_bytes: computeMemLimit(stats, inspect, hostTotalBytes),
    net_rx_bytes: net.rx,
    net_tx_bytes: net.tx,
  }
}

const buildNodeInfo = (info: DockerInfo, host: Awaited<ReturnType<typeof readHostSample>>): NodeInfo => {
  const swarmNodeId = info.Swarm?.NodeID?.trim() || info.ID
  const hostname = config.nodeName || info.Name
  return {
    swarm_node_id: swarmNodeId,
    hostname,
    num_cpus: info.NCPU ?? 0,
    cpu_pct: host.cpuPct,
    mem_used_bytes: host.memUsedBytes,
    mem_total_bytes: host.memTotalBytes,
    load1: host.load1,
    load5: host.load5,
    load15: host.load15,
  }
}

// Collect one full snapshot: node identity + host sample + per-container stats.
export const collect = async (): Promise<MetricsIngestPayload> => {
  const info = await getNodeInfo()
  const host = await readHostSample(0) // host mem total is authoritative; 0 fallback

  const containers = await listRunningContainers()
  const liveIds = new Set(containers.map((c) => c.Id))
  pruneInspectCache(liveIds)

  const results = await mapWithConcurrency(containers, config.statsConcurrency, async (c) => {
    const [stats, inspect] = await Promise.all([getContainerStats(c.Id), getInspectCached(c.Id)])
    return buildContainerMetrics(c, stats, inspect, host.memTotalBytes)
  })

  const containerMetrics: ContainerMetrics[] = []
  for (const r of results) {
    if ('value' in r) {
      containerMetrics.push(r.value)
    } else {
      log.debug('container stats failed, skipping', {
        id: r.item.Id.slice(0, 12),
        error: String(r.error),
      })
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    collector_version: COLLECTOR_VERSION,
    collected_at: new Date().toISOString(),
    interval_ms: config.intervalMs,
    dropped_batches: 0, // filled in by the sender before POST
    node: buildNodeInfo(info, host),
    containers: containerMetrics,
  }
}
