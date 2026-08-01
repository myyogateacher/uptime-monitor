// Payload contract between the swarm metrics sidecar and the uptime-monitor
// server (`POST /api/metrics/ingest`). The server mirrors these shapes in
// server/metricsService.ts — keep the two in sync when changing anything here.

export const SCHEMA_VERSION = 1;

export interface NodeInfo {
  /** Swarm NodeID from GET /info; falls back to the daemon ID off-swarm. */
  swarm_node_id: string;
  hostname: string;
  num_cpus: number;
  /** Host CPU usage normalized 0-100 across all cores (/proc/stat delta). Null on the first tick. */
  cpu_pct: number | null;
  /** MemTotal - MemAvailable from /proc/meminfo. */
  mem_used_bytes: number;
  mem_total_bytes: number;
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

export interface ContainerMetrics {
  /** Full 64-hex container id — the stable join key. */
  container_id: string;
  name: string;
  image: string;
  /**
   * Service identity, resolved via a fallback chain (swarm > compose > name):
   * com.docker.swarm.service.name, else com.docker.compose.service, else the
   * container name with trailing machine-generated segments stripped (bare
   * `docker run`): UUIDs, hex blobs and timestamp-like suffixes are removed so
   * ephemeral containers group under one service — `recorder-3f9a12ab-...`
   * becomes `recorder`, while `worker-2` keeps its replica suffix. Stripping
   * never applies to swarm/compose names. Only null when a container has no
   * name at all.
   */
  service_name: string | null;
  /**
   * com.docker.swarm.task.name for swarm; otherwise the container name (compose
   * and bare-run fallbacks).
   */
  task_name: string | null;
  /** Replica slot parsed from the task name (service.SLOT.taskid). */
  replica_slot: number | null;
  /**
   * com.docker.stack.namespace for swarm, else com.docker.compose.project for
   * compose; null for bare containers.
   */
  stack_namespace: string | null;
  /** docker-stats semantics: 100 = one full core; can exceed 100 on multi-core quota. */
  cpu_pct: number;
  /** HostConfig.NanoCpus / 1e9 (or CpuQuota/CpuPeriod); null when unlimited. */
  cpu_quota_cores: number | null;
  /** cgroup usage minus inactive_file (v2) / cache (v1). */
  mem_used_bytes: number;
  /** cgroup limit; null when effectively unlimited (≈ host total). */
  mem_limit_bytes: number | null;
  /** Cumulative counters summed across interfaces. Server computes rates. */
  net_rx_bytes: number;
  net_tx_bytes: number;
}

export interface MetricsIngestPayload {
  schema_version: typeof SCHEMA_VERSION;
  collector_version: string;
  /** ISO-8601 UTC; the server floors this to the minute bucket. */
  collected_at: string;
  interval_ms: number;
  /** Buffered batches dropped since the last successful POST (observability). */
  dropped_batches: number;
  node: NodeInfo;
  containers: ContainerMetrics[];
}
