import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { config } from './config'
import { pool } from './db'
import { notifyMetricAlert } from './notifier'

// Payload contract mirrored from sidecar-swarm/src/types.ts. Keep in sync.
const SCHEMA_VERSION = 1

interface NodeInfo {
  swarm_node_id: string
  hostname: string
  num_cpus: number
  cpu_pct: number | null
  mem_used_bytes: number
  mem_total_bytes: number
  load1: number | null
  load5: number | null
  load15: number | null
}

interface ContainerMetrics {
  container_id: string
  name: string
  image: string
  service_name: string | null
  task_name: string | null
  replica_slot: number | null
  stack_namespace: string | null
  cpu_pct: number
  cpu_quota_cores: number | null
  mem_used_bytes: number
  mem_limit_bytes: number | null
  net_rx_bytes: number
  net_tx_bytes: number
}

export interface MetricsIngestPayload {
  schema_version: number
  collector_version: string
  collected_at: string
  interval_ms: number
  dropped_batches: number
  node: NodeInfo
  containers: ContainerMetrics[]
}

export type MetricScope = 'node' | 'service' | 'container'
export type MetricKind = 'cpu' | 'memory'
export type MetricOperator = '>' | '>=' | '<' | '<='
export type MetricGranularity = 'minute' | 'hour' | 'day'

export const METRIC_SCOPES = new Set<MetricScope>(['node', 'service', 'container'])
export const METRIC_KINDS = new Set<MetricKind>(['cpu', 'memory'])
export const METRIC_OPERATORS = new Set<MetricOperator>(['>', '>=', '<', '<='])
export const METRIC_GRANULARITIES = new Set<MetricGranularity>(['minute', 'hour', 'day'])

export const METRIC_RETENTION_DAYS = config.metrics.retentionDays

const RETENTION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
// Newest data older than this means the collector is silent; skip alerting.
const ALERT_STALE_MINUTES = 3
// Wildcard rules resolve to entities seen within this window.
const ALERT_LIVE_WINDOW_MINUTES = 10

let timer: ReturnType<typeof setInterval> | null = null
let isTickRunning = false
let lastRetentionCleanupAt = 0
let lastAlertAt = 0

// container_key -> metric_containers.id, populated during ingest to avoid
// hot-path SELECTs. Cleared when dimension pruning runs.
const nodeIdCache = new Map<string, number>()
const serviceIdCache = new Map<string, number>()
const containerIdCache = new Map<string, number>()

const toSqlDateTime = (date: Date): string => date.toISOString().slice(0, 19).replace('T', ' ')

const floorToMinute = (date: Date): Date => {
  const floored = new Date(date)
  floored.setUTCSeconds(0, 0)
  return floored
}

const toFiniteOrNull = (value: unknown): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Timeseries queries operate over an explicit half-open [from, to) window.
// bucket_start columns are stored as UTC datetimes, so windows are formatted
// as 'YYYY-MM-DD HH:MM:SS' in UTC to compare directly.
export type MetricWindow = { from: Date; to: Date }

const toMysqlUtc = (value: Date): string =>
  value.toISOString().slice(0, 19).replace('T', ' ')

// Aggregation ("group by") applied when re-bucketing minute rollups. avg/sum/
// count/max are computed in SQL; p95/p99 are computed in JS over the per-minute
// average values within each output bucket.
export type MetricAgg = 'avg' | 'sum' | 'count' | 'max' | 'p95' | 'p99'
export const METRIC_AGGS = new Set<MetricAgg>([
  'avg',
  'sum',
  'count',
  'max',
  'p95',
  'p99',
])

const isPercentileAgg = (agg: MetricAgg): boolean => agg === 'p95' || agg === 'p99'

// Nearest-rank percentile over an ascending-sorted array.
const percentileOf = (sortedAsc: number[], percentile: number): number | null => {
  if (!sortedAsc.length) return null
  const rank = Math.ceil((percentile / 100) * sortedAsc.length)
  const index = Math.min(sortedAsc.length, Math.max(1, rank)) - 1
  return sortedAsc[index]
}

// Truncate a minute-level 'YYYY-MM-DD HH:MM:SS' string down to a granularity
// bucket key (mirrors bucketExprFor but in JS, for the percentile path).
const bucketKeyFor = (
  granularity: MetricGranularity,
  minuteStart: string,
): string => {
  if (granularity === 'day') return `${minuteStart.slice(0, 10)} 00:00:00`
  if (granularity === 'hour') return `${minuteStart.slice(0, 13)}:00:00`
  return `${minuteStart.slice(0, 16)}:00`
}

// Selects the requested aggregate from precomputed per-bucket components.
// Percentiles are resolved separately and never reach this helper.
const pickAgg = (
  agg: MetricAgg,
  components: {
    avg: number | null
    sum: number | null
    count: number | null
    max: number | null
  },
): number | null => {
  switch (agg) {
    case 'sum':
      return components.sum
    case 'count':
      return components.count
    case 'max':
      return components.max
    default:
      return components.avg
  }
}

// Builds a TimeseriesPoint from a single aggregated scalar. For memory the
// scalar is a byte value (except count, which is a sample count) and `avg` also
// carries a percentage of `reference` (mem total/limit) for aggregates where
// that is meaningful.
const buildScalarPoint = (
  bucketStart: string,
  metric: MetricKind,
  agg: MetricAgg,
  value: number | null,
  reference: number | null,
): TimeseriesPoint => {
  if (metric === 'memory') {
    const pct =
      agg === 'count'
        ? value
        : value != null && reference
          ? (value / reference) * 100
          : null
    return {
      bucket_start: bucketStart,
      avg: pct,
      max: pct,
      avg_bytes: value,
      max_bytes: value,
    }
  }
  return {
    bucket_start: bucketStart,
    avg: value,
    max: value,
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface IdRow extends RowDataPacket {
  id: number
  key_col: string
}

const upsertNode = async (node: NodeInfo): Promise<number> => {
  const cached = nodeIdCache.get(node.swarm_node_id)
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO metric_nodes (node_key, hostname, cpu_cores, mem_total_bytes, last_seen)
      VALUES (?, ?, ?, ?, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE
        id = LAST_INSERT_ID(id),
        hostname = VALUES(hostname),
        cpu_cores = VALUES(cpu_cores),
        mem_total_bytes = VALUES(mem_total_bytes),
        last_seen = VALUES(last_seen)
    `,
    [node.swarm_node_id, node.hostname, node.num_cpus, node.mem_total_bytes],
  )
  const id = cached ?? result.insertId
  nodeIdCache.set(node.swarm_node_id, id)
  return id
}

const upsertServices = async (serviceNames: string[]): Promise<void> => {
  if (!serviceNames.length) return

  await pool.query(
    `
      INSERT INTO metric_services (service_name, last_seen)
      VALUES ${serviceNames.map(() => '(?, UTC_TIMESTAMP())').join(', ')}
      ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen)
    `,
    serviceNames,
  )

  const missing = serviceNames.filter((name) => !serviceIdCache.has(name))
  if (!missing.length) return

  const [rows] = await pool.query<IdRow[]>(
    `SELECT id, service_name AS key_col FROM metric_services WHERE service_name IN (${missing
      .map(() => '?')
      .join(', ')})`,
    missing,
  )
  for (const row of rows) serviceIdCache.set(row.key_col, row.id)
}

const upsertContainers = async (
  containers: ContainerMetrics[],
  nodeId: number,
): Promise<void> => {
  if (!containers.length) return

  const values: unknown[] = []
  const placeholders = containers.map((container) => {
    const serviceId = container.service_name
      ? serviceIdCache.get(container.service_name) ?? null
      : null
    values.push(
      container.container_id,
      nodeId,
      serviceId,
      container.name,
      container.image,
      container.task_name,
      container.replica_slot,
      container.stack_namespace,
      container.cpu_quota_cores,
      container.mem_limit_bytes,
    )
    return '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())'
  })

  await pool.query(
    `
      INSERT INTO metric_containers (
        container_key, node_id, service_id, name, image, task_name,
        replica_slot, stack_namespace, cpu_quota_cores, mem_limit_bytes, last_seen
      )
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        node_id = VALUES(node_id),
        service_id = VALUES(service_id),
        name = VALUES(name),
        image = VALUES(image),
        task_name = VALUES(task_name),
        replica_slot = VALUES(replica_slot),
        stack_namespace = VALUES(stack_namespace),
        cpu_quota_cores = VALUES(cpu_quota_cores),
        mem_limit_bytes = VALUES(mem_limit_bytes),
        last_seen = VALUES(last_seen)
    `,
    values,
  )

  const missing = containers
    .map((container) => container.container_id)
    .filter((key) => !containerIdCache.has(key))
  if (!missing.length) return

  const [rows] = await pool.query<IdRow[]>(
    `SELECT id, container_key AS key_col FROM metric_containers WHERE container_key IN (${missing
      .map(() => '?')
      .join(', ')})`,
    missing,
  )
  for (const row of rows) containerIdCache.set(row.key_col, row.id)
}

const upsertNodeSample = async (
  nodeId: number,
  bucketStart: string,
  node: NodeInfo,
): Promise<void> => {
  // cpu_pct is null on the collector's first tick; skip so the running average
  // (cpu_pct_sum / sample_count) stays accurate.
  if (node.cpu_pct == null) return

  await pool.query(
    `
      INSERT INTO metric_node_samples (
        entity_id, bucket_start, sample_count, cpu_pct_sum, cpu_pct_max,
        mem_used_sum, mem_used_max, mem_total_last
      )
      VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        sample_count = sample_count + 1,
        cpu_pct_sum = cpu_pct_sum + VALUES(cpu_pct_sum),
        cpu_pct_max = GREATEST(cpu_pct_max, VALUES(cpu_pct_max)),
        mem_used_sum = mem_used_sum + VALUES(mem_used_sum),
        mem_used_max = GREATEST(mem_used_max, VALUES(mem_used_max)),
        mem_total_last = VALUES(mem_total_last)
    `,
    [
      nodeId,
      bucketStart,
      node.cpu_pct,
      node.cpu_pct,
      node.mem_used_bytes,
      node.mem_used_bytes,
      node.mem_total_bytes,
    ],
  )
}

const upsertContainerSamples = async (
  containers: ContainerMetrics[],
  bucketStart: string,
): Promise<void> => {
  const values: unknown[] = []
  const placeholders: string[] = []

  for (const container of containers) {
    const entityId = containerIdCache.get(container.container_id)
    if (entityId == null) continue
    values.push(
      entityId,
      bucketStart,
      container.cpu_pct,
      container.cpu_pct,
      container.mem_used_bytes,
      container.mem_used_bytes,
      container.cpu_quota_cores,
      container.mem_limit_bytes,
      container.net_rx_bytes,
      container.net_tx_bytes,
    )
    placeholders.push('(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
  }

  if (!placeholders.length) return

  await pool.query(
    `
      INSERT INTO metric_container_samples (
        entity_id, bucket_start, sample_count, cpu_pct_sum, cpu_pct_max,
        mem_used_sum, mem_used_max, cpu_quota_cores_last, mem_limit_bytes_last,
        net_rx_last, net_tx_last
      )
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        sample_count = sample_count + 1,
        cpu_pct_sum = cpu_pct_sum + VALUES(cpu_pct_sum),
        cpu_pct_max = GREATEST(cpu_pct_max, VALUES(cpu_pct_max)),
        mem_used_sum = mem_used_sum + VALUES(mem_used_sum),
        mem_used_max = GREATEST(mem_used_max, VALUES(mem_used_max)),
        cpu_quota_cores_last = VALUES(cpu_quota_cores_last),
        mem_limit_bytes_last = VALUES(mem_limit_bytes_last),
        net_rx_last = VALUES(net_rx_last),
        net_tx_last = VALUES(net_tx_last)
    `,
    values,
  )
}

export type IngestResult = {
  accepted: true
  bucket_start: string
  node: string
  containers: number
}

export async function ingestBatch(payload: unknown): Promise<IngestResult> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be a JSON object')
  }

  const body = payload as Partial<MetricsIngestPayload>
  if (Number(body.schema_version) !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema_version (expected ${SCHEMA_VERSION})`)
  }

  const collectedAt = new Date(String(body.collected_at ?? ''))
  if (Number.isNaN(collectedAt.getTime())) {
    throw new Error('collected_at must be a valid ISO timestamp')
  }

  const node = body.node
  if (!node || typeof node !== 'object' || !String(node.swarm_node_id ?? '').trim()) {
    throw new Error('node.swarm_node_id is required')
  }

  const containers = Array.isArray(body.containers) ? body.containers : []
  const bucketStart = toSqlDateTime(floorToMinute(collectedAt))

  const nodeId = await upsertNode(node)

  const serviceNames = Array.from(
    new Set(
      containers
        .map((container) => (container.service_name ? String(container.service_name) : null))
        .filter((name): name is string => Boolean(name)),
    ),
  )
  await upsertServices(serviceNames)
  await upsertContainers(containers, nodeId)

  await upsertNodeSample(nodeId, bucketStart, node)
  await upsertContainerSamples(containers, bucketStart)

  return {
    accepted: true,
    bucket_start: bucketStart,
    node: String(node.swarm_node_id),
    containers: containers.length,
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const bucketExprFor = (granularity: MetricGranularity): string => {
  if (granularity === 'hour') return "DATE_FORMAT(bucket_start, '%Y-%m-%d %H:00:00')"
  if (granularity === 'day') return "DATE_FORMAT(bucket_start, '%Y-%m-%d 00:00:00')"
  return "DATE_FORMAT(bucket_start, '%Y-%m-%d %H:%i:00')"
}

interface NodeOverviewRow extends RowDataPacket {
  node_key: string
  hostname: string | null
  cpu_cores: number | null
  mem_total_bytes: number | null
  last_seen: Date | string | null
  bucket_start: string | null
  cpu_pct: number | null
  cpu_pct_max: number | null
  mem_used_bytes: number | null
  mem_total_last: number | null
  container_count: number | null
}

interface ServiceOverviewRow extends RowDataPacket {
  service_name: string
  container_count: number
  node_count: number
  cpu_pct_total: number | null
  mem_used_total: number | null
  total_quota_cores: number | null
  total_mem_limit_bytes: number | null
  last_seen: Date | string | null
}

const listNodesQuery = async (): Promise<NodeOverviewRow[]> => {
  const [rows] = await pool.query<NodeOverviewRow[]>(
    `
      SELECT
        n.node_key,
        n.hostname,
        n.cpu_cores,
        n.mem_total_bytes,
        n.last_seen,
        s.bucket_start,
        s.cpu_pct_sum / s.sample_count AS cpu_pct,
        s.cpu_pct_max,
        s.mem_used_sum / s.sample_count AS mem_used_bytes,
        s.mem_total_last,
        (
          SELECT COUNT(*)
          FROM metric_containers mc
          WHERE mc.node_id = n.id
            AND mc.last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
        ) AS container_count
      FROM metric_nodes n
      LEFT JOIN metric_node_samples s
        ON s.entity_id = n.id
        AND s.bucket_start = (
          SELECT MAX(bucket_start) FROM metric_node_samples WHERE entity_id = n.id
        )
      ORDER BY n.hostname ASC, n.node_key ASC
    `,
  )
  return rows
}

const listServicesQuery = async (nodeKey?: string): Promise<ServiceOverviewRow[]> => {
  const params: unknown[] = []
  let nodeFilter = ''
  if (nodeKey) {
    nodeFilter = 'AND n.node_key = ?'
    params.push(nodeKey)
  }

  const [rows] = await pool.query<ServiceOverviewRow[]>(
    `
      SELECT
        sv.service_name,
        COUNT(DISTINCT c.id) AS container_count,
        COUNT(DISTINCT c.node_id) AS node_count,
        SUM(latest.cpu_pct) AS cpu_pct_total,
        SUM(latest.mem_used_bytes) AS mem_used_total,
        SUM(c.cpu_quota_cores) AS total_quota_cores,
        SUM(c.mem_limit_bytes) AS total_mem_limit_bytes,
        MAX(c.last_seen) AS last_seen
      FROM metric_services sv
      JOIN metric_containers c ON c.service_id = sv.id
      LEFT JOIN metric_nodes n ON n.id = c.node_id
      LEFT JOIN (
        SELECT
          cs.entity_id,
          cs.cpu_pct_sum / cs.sample_count AS cpu_pct,
          cs.mem_used_sum / cs.sample_count AS mem_used_bytes
        FROM metric_container_samples cs
        JOIN (
          SELECT entity_id, MAX(bucket_start) AS mb
          FROM metric_container_samples
          GROUP BY entity_id
        ) m ON m.entity_id = cs.entity_id AND m.mb = cs.bucket_start
      ) latest ON latest.entity_id = c.id
      WHERE 1 = 1 ${nodeFilter}
      GROUP BY sv.id
      ORDER BY sv.service_name ASC
    `,
    params,
  )
  return rows
}

const serializeNodeOverview = (row: NodeOverviewRow) => ({
  node_key: row.node_key,
  hostname: row.hostname,
  cpu_cores: row.cpu_cores,
  mem_total_bytes: row.mem_total_bytes == null ? null : Number(row.mem_total_bytes),
  last_seen: row.last_seen,
  bucket_start: row.bucket_start,
  cpu_pct: toFiniteOrNull(row.cpu_pct),
  cpu_pct_max: toFiniteOrNull(row.cpu_pct_max),
  mem_used_bytes: row.mem_used_bytes == null ? null : Number(row.mem_used_bytes),
  mem_total_bytes_last: row.mem_total_last == null ? null : Number(row.mem_total_last),
  mem_pct:
    row.mem_used_bytes != null && row.mem_total_last
      ? (Number(row.mem_used_bytes) / Number(row.mem_total_last)) * 100
      : null,
  container_count: Number(row.container_count ?? 0),
})

const serializeServiceOverview = (row: ServiceOverviewRow) => {
  const memUsed = row.mem_used_total == null ? null : Number(row.mem_used_total)
  const memLimit = row.total_mem_limit_bytes == null ? null : Number(row.total_mem_limit_bytes)
  return {
    service_name: row.service_name,
    container_count: Number(row.container_count),
    node_count: Number(row.node_count),
    cpu_pct_total: toFiniteOrNull(row.cpu_pct_total),
    mem_used_bytes: memUsed,
    total_quota_cores: row.total_quota_cores == null ? null : Number(row.total_quota_cores),
    total_mem_limit_bytes: memLimit,
    mem_pct: memUsed != null && memLimit ? (memUsed / memLimit) * 100 : null,
    last_seen: row.last_seen,
  }
}

export async function getOverview() {
  const [nodes, services] = await Promise.all([listNodesQuery(), listServicesQuery()])
  return {
    nodes: nodes.map(serializeNodeOverview),
    services: services.map(serializeServiceOverview),
  }
}

export async function listNodes() {
  const rows = await listNodesQuery()
  return rows.map(serializeNodeOverview)
}

export async function listServices() {
  const rows = await listServicesQuery()
  return rows.map(serializeServiceOverview)
}

export async function listServicesOnNode(nodeKey: string) {
  const rows = await listServicesQuery(nodeKey)
  return rows.map(serializeServiceOverview)
}

interface ContainerListRow extends RowDataPacket {
  container_key: string
  name: string | null
  image: string | null
  task_name: string | null
  replica_slot: number | null
  node_key: string | null
  hostname: string | null
  cpu_quota_cores: number | null
  mem_limit_bytes: number | null
  last_seen: Date | string | null
  cpu_pct: number | null
  cpu_pct_max: number | null
  mem_used_bytes: number | null
}

const serializeContainerRow = (row: ContainerListRow) => {
  const memUsed = row.mem_used_bytes == null ? null : Number(row.mem_used_bytes)
  const memLimit = row.mem_limit_bytes == null ? null : Number(row.mem_limit_bytes)
  return {
    container_key: row.container_key,
    name: row.name,
    image: row.image,
    task_name: row.task_name,
    replica_slot: row.replica_slot,
    node_key: row.node_key,
    hostname: row.hostname,
    cpu_quota_cores: row.cpu_quota_cores == null ? null : Number(row.cpu_quota_cores),
    mem_limit_bytes: memLimit,
    last_seen: row.last_seen,
    cpu_pct: toFiniteOrNull(row.cpu_pct),
    cpu_pct_max: toFiniteOrNull(row.cpu_pct_max),
    mem_used_bytes: memUsed,
    mem_pct: memUsed != null && memLimit ? (memUsed / memLimit) * 100 : null,
  }
}

export async function listServiceContainers(serviceName: string) {
  const [rows] = await pool.query<ContainerListRow[]>(
    `
      SELECT
        c.container_key,
        c.name,
        c.image,
        c.task_name,
        c.replica_slot,
        n.node_key,
        n.hostname,
        c.cpu_quota_cores,
        c.mem_limit_bytes,
        c.last_seen,
        latest.cpu_pct,
        latest.cpu_pct_max,
        latest.mem_used_bytes
      FROM metric_services sv
      JOIN metric_containers c ON c.service_id = sv.id
      LEFT JOIN metric_nodes n ON n.id = c.node_id
      LEFT JOIN (
        SELECT
          cs.entity_id,
          cs.cpu_pct_sum / cs.sample_count AS cpu_pct,
          cs.cpu_pct_max,
          cs.mem_used_sum / cs.sample_count AS mem_used_bytes
        FROM metric_container_samples cs
        JOIN (
          SELECT entity_id, MAX(bucket_start) AS mb
          FROM metric_container_samples
          GROUP BY entity_id
        ) m ON m.entity_id = cs.entity_id AND m.mb = cs.bucket_start
      ) latest ON latest.entity_id = c.id
      WHERE sv.service_name = ?
      ORDER BY c.replica_slot ASC, c.name ASC
    `,
    [serviceName],
  )
  return rows.map(serializeContainerRow)
}

interface NodeSampleRow extends RowDataPacket {
  bucket_start: string
  cpu_sum: number | null
  cpu_max: number | null
  mem_sum: number | null
  mem_max: number | null
  sample_count: number | null
  mem_total_bytes: number | null
}

interface NodeMinuteRow extends RowDataPacket {
  bucket_start: string
  cpu_pct_sum: number | null
  mem_used_sum: number | null
  sample_count: number | null
  mem_total_last: number | null
}

export type TimeseriesPoint = {
  bucket_start: string
  avg: number | null
  max: number | null
  avg_bytes?: number | null
  max_bytes?: number | null
  net_rx_bps?: number | null
  net_tx_bps?: number | null
}

export async function getNodeTimeseries(
  nodeKey: string,
  metric: MetricKind,
  granularity: MetricGranularity,
  window: MetricWindow,
  agg: MetricAgg = 'avg',
): Promise<{ node: Record<string, unknown>; points: TimeseriesPoint[] } | null> {
  const [nodeRows] = await pool.query<
    ({ id: number; node_key: string; hostname: string | null; cpu_cores: number | null; mem_total_bytes: number | null } & RowDataPacket)[]
  >(
    'SELECT id, node_key, hostname, cpu_cores, mem_total_bytes FROM metric_nodes WHERE node_key = ? LIMIT 1',
    [nodeKey],
  )
  if (!nodeRows.length) return null
  const node = nodeRows[0]

  const fromStr = toMysqlUtc(window.from)
  const toStr = toMysqlUtc(window.to)

  const nodeSubject = {
    node_key: node.node_key,
    hostname: node.hostname,
    cpu_cores: node.cpu_cores,
    mem_total_bytes: node.mem_total_bytes == null ? null : Number(node.mem_total_bytes),
  }

  if (isPercentileAgg(agg)) {
    const [minuteRows] = await pool.query<NodeMinuteRow[]>(
      `
        SELECT bucket_start, cpu_pct_sum, mem_used_sum, sample_count, mem_total_last
        FROM metric_node_samples
        WHERE entity_id = ?
          AND bucket_start >= ?
          AND bucket_start < ?
        ORDER BY bucket_start ASC
      `,
      [node.id, fromStr, toStr],
    )
    const points = percentilePoints(
      minuteRows,
      granularity,
      metric,
      agg,
      (row) => {
        const count = Number(row.sample_count) || 0
        const sum = metric === 'memory' ? Number(row.mem_used_sum) : Number(row.cpu_pct_sum)
        return count ? sum / count : null
      },
      (row) => (row.mem_total_last == null ? null : Number(row.mem_total_last)),
    )
    return { node: nodeSubject, points }
  }

  const bucketExpr = bucketExprFor(granularity)
  const [rows] = await pool.query<NodeSampleRow[]>(
    `
      SELECT
        ${bucketExpr} AS bucket_start,
        SUM(cpu_pct_sum) AS cpu_sum,
        MAX(cpu_pct_max) AS cpu_max,
        SUM(mem_used_sum) AS mem_sum,
        MAX(mem_used_max) AS mem_max,
        SUM(sample_count) AS sample_count,
        MAX(mem_total_last) AS mem_total_bytes
      FROM metric_node_samples
      WHERE entity_id = ?
        AND bucket_start >= ?
        AND bucket_start < ?
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    [node.id, fromStr, toStr],
  )

  const points: TimeseriesPoint[] = rows.map((row) => {
    const count = row.sample_count == null ? null : Number(row.sample_count)
    const total = row.mem_total_bytes == null ? null : Number(row.mem_total_bytes)
    if (metric === 'memory') {
      const sum = row.mem_sum == null ? null : Number(row.mem_sum)
      const value = pickAgg(agg, {
        avg: sum != null && count ? sum / count : null,
        sum,
        count,
        max: row.mem_max == null ? null : Number(row.mem_max),
      })
      return buildScalarPoint(row.bucket_start, metric, agg, value, total)
    }
    const sum = row.cpu_sum == null ? null : Number(row.cpu_sum)
    const value = pickAgg(agg, {
      avg: sum != null && count ? sum / count : null,
      sum,
      count,
      max: row.cpu_max == null ? null : Number(row.cpu_max),
    })
    return buildScalarPoint(row.bucket_start, metric, agg, value, null)
  })

  return { node: nodeSubject, points }
}

// Shared JS percentile path: buckets per-minute rows, computes each minute's
// value via `minuteValue`, then takes the nearest-rank percentile per bucket.
// `reference` (mem total/limit) is carried as the max seen within the bucket.
function percentilePoints<Row extends RowDataPacket>(
  minuteRows: Row[],
  granularity: MetricGranularity,
  metric: MetricKind,
  agg: MetricAgg,
  minuteValue: (row: Row) => number | null,
  referenceOf?: (row: Row) => number | null,
): TimeseriesPoint[] {
  const buckets = new Map<string, { values: number[]; reference: number | null }>()
  for (const row of minuteRows) {
    const key = bucketKeyFor(granularity, String(row.bucket_start))
    let entry = buckets.get(key)
    if (!entry) {
      entry = { values: [], reference: null }
      buckets.set(key, entry)
    }
    const value = minuteValue(row)
    if (value != null && Number.isFinite(value)) entry.values.push(value)
    if (referenceOf) {
      const reference = referenceOf(row)
      if (reference != null) {
        entry.reference = entry.reference == null ? reference : Math.max(entry.reference, reference)
      }
    }
  }
  const percentile = agg === 'p99' ? 99 : 95
  return [...buckets.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([key, entry]) => {
      const sorted = entry.values.slice().sort((left, right) => left - right)
      return buildScalarPoint(key, metric, agg, percentileOf(sorted, percentile), entry.reference)
    })
}

interface ServiceSampleRow extends RowDataPacket {
  bucket_start: string
  cpu_avg: number | null
  cpu_sum: number | null
  cpu_max: number | null
  mem_used_avg: number | null
  mem_used_sum: number | null
  mem_used_max: number | null
  sample_count: number | null
}

interface ServiceMinuteRow extends RowDataPacket {
  minute: string
  cpu_total: number | null
  mem_used_total: number | null
}

export async function getServiceTimeseries(
  serviceName: string,
  metric: MetricKind,
  granularity: MetricGranularity,
  window: MetricWindow,
  agg: MetricAgg = 'avg',
): Promise<{ service: Record<string, unknown>; points: TimeseriesPoint[] } | null> {
  const [serviceRows] = await pool.query<({ id: number } & RowDataPacket)[]>(
    'SELECT id FROM metric_services WHERE service_name = ? LIMIT 1',
    [serviceName],
  )
  if (!serviceRows.length) return null
  const serviceId = serviceRows[0].id

  const [totalRows] = await pool.query<
    ({ total_quota_cores: number | null; total_mem_limit_bytes: number | null; replicas: number; null_limits: number } & RowDataPacket)[]
  >(
    `
      SELECT
        SUM(cpu_quota_cores) AS total_quota_cores,
        SUM(mem_limit_bytes) AS total_mem_limit_bytes,
        COUNT(*) AS replicas,
        SUM(CASE WHEN mem_limit_bytes IS NULL THEN 1 ELSE 0 END) AS null_limits
      FROM metric_containers
      WHERE service_id = ?
    `,
    [serviceId],
  )
  const totalQuota =
    totalRows[0]?.total_quota_cores == null ? null : Number(totalRows[0].total_quota_cores)
  const totalMemLimit =
    Number(totalRows[0]?.null_limits ?? 0) > 0 || totalRows[0]?.total_mem_limit_bytes == null
      ? null
      : Number(totalRows[0].total_mem_limit_bytes)

  const fromStr = toMysqlUtc(window.from)
  const toStr = toMysqlUtc(window.to)
  const serviceSubject = {
    service_name: serviceName,
    total_quota_cores: totalQuota,
    total_mem_limit_bytes: totalMemLimit,
  }

  if (isPercentileAgg(agg)) {
    // Per-minute totals across replicas; percentile taken over those minutes.
    const [minuteRows] = await pool.query<ServiceMinuteRow[]>(
      `
        SELECT
          cs.bucket_start AS minute,
          SUM(cs.cpu_pct_sum / cs.sample_count) AS cpu_total,
          SUM(cs.mem_used_sum / cs.sample_count) AS mem_used_total
        FROM metric_container_samples cs
        JOIN metric_containers c ON c.id = cs.entity_id
        WHERE c.service_id = ?
          AND cs.bucket_start >= ?
          AND cs.bucket_start < ?
        GROUP BY cs.bucket_start
        ORDER BY cs.bucket_start ASC
      `,
      [serviceId, fromStr, toStr],
    )
    const points = percentilePoints(
      minuteRows.map((row) => ({ ...row, bucket_start: row.minute })),
      granularity,
      metric,
      agg,
      (row) =>
        metric === 'memory'
          ? row.mem_used_total == null
            ? null
            : Number(row.mem_used_total)
          : row.cpu_total == null
            ? null
            : Number(row.cpu_total),
      () => totalMemLimit,
    )
    return { service: serviceSubject, points }
  }

  const bucketExpr = bucketExprFor(granularity)
  // Inner query totals across replicas per minute; outer re-buckets over time.
  const [rows] = await pool.query<ServiceSampleRow[]>(
    `
      SELECT
        ${bucketExpr.replace(/bucket_start/g, 'm.minute')} AS bucket_start,
        AVG(m.cpu_total) AS cpu_avg,
        SUM(m.cpu_total) AS cpu_sum,
        MAX(m.cpu_max_total) AS cpu_max,
        AVG(m.mem_used_total) AS mem_used_avg,
        SUM(m.mem_used_total) AS mem_used_sum,
        MAX(m.mem_used_max_total) AS mem_used_max,
        SUM(m.sample_count_total) AS sample_count
      FROM (
        SELECT
          cs.bucket_start AS minute,
          SUM(cs.cpu_pct_sum / cs.sample_count) AS cpu_total,
          SUM(cs.cpu_pct_max) AS cpu_max_total,
          SUM(cs.mem_used_sum / cs.sample_count) AS mem_used_total,
          SUM(cs.mem_used_max) AS mem_used_max_total,
          SUM(cs.sample_count) AS sample_count_total
        FROM metric_container_samples cs
        JOIN metric_containers c ON c.id = cs.entity_id
        WHERE c.service_id = ?
          AND cs.bucket_start >= ?
          AND cs.bucket_start < ?
        GROUP BY cs.bucket_start
      ) m
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    [serviceId, fromStr, toStr],
  )

  const points: TimeseriesPoint[] = rows.map((row) => {
    const count = row.sample_count == null ? null : Number(row.sample_count)
    if (metric === 'memory') {
      const value = pickAgg(agg, {
        avg: row.mem_used_avg == null ? null : Number(row.mem_used_avg),
        sum: row.mem_used_sum == null ? null : Number(row.mem_used_sum),
        count,
        max: row.mem_used_max == null ? null : Number(row.mem_used_max),
      })
      return buildScalarPoint(row.bucket_start, metric, agg, value, totalMemLimit)
    }
    const value = pickAgg(agg, {
      avg: row.cpu_avg == null ? null : Number(row.cpu_avg),
      sum: row.cpu_sum == null ? null : Number(row.cpu_sum),
      count,
      max: row.cpu_max == null ? null : Number(row.cpu_max),
    })
    return buildScalarPoint(row.bucket_start, metric, agg, value, null)
  })

  return {
    service: serviceSubject,
    points,
  }
}

interface ContainerSampleRow extends RowDataPacket {
  bucket_start: string
  cpu_sum: number | null
  cpu_max: number | null
  mem_sum: number | null
  mem_max: number | null
  sample_count: number | null
  mem_limit_bytes: number | null
  cpu_quota_cores: number | null
  net_rx_last: number | null
  net_tx_last: number | null
}

interface ContainerMinuteRow extends RowDataPacket {
  bucket_start: string
  cpu_pct_sum: number | null
  mem_used_sum: number | null
  sample_count: number | null
  mem_limit_bytes_last: number | null
}

export async function getContainerTimeseries(
  containerKey: string,
  metric: MetricKind,
  granularity: MetricGranularity,
  window: MetricWindow,
  agg: MetricAgg = 'avg',
): Promise<{ container: Record<string, unknown>; points: TimeseriesPoint[] } | null> {
  const [containerRows] = await pool.query<
    ({ id: number; container_key: string; name: string | null; task_name: string | null; cpu_quota_cores: number | null; mem_limit_bytes: number | null } & RowDataPacket)[]
  >(
    'SELECT id, container_key, name, task_name, cpu_quota_cores, mem_limit_bytes FROM metric_containers WHERE container_key = ? LIMIT 1',
    [containerKey],
  )
  if (!containerRows.length) return null
  const container = containerRows[0]

  const fromStr = toMysqlUtc(window.from)
  const toStr = toMysqlUtc(window.to)

  const bucketExpr = bucketExprFor(granularity)
  // The grouped query always yields the per-bucket net rate inputs plus the
  // SQL aggregates; percentiles later override only the plotted value field.
  const [rows] = await pool.query<ContainerSampleRow[]>(
    `
      SELECT
        ${bucketExpr} AS bucket_start,
        SUM(cpu_pct_sum) AS cpu_sum,
        MAX(cpu_pct_max) AS cpu_max,
        SUM(mem_used_sum) AS mem_sum,
        MAX(mem_used_max) AS mem_max,
        SUM(sample_count) AS sample_count,
        MAX(mem_limit_bytes_last) AS mem_limit_bytes,
        MAX(cpu_quota_cores_last) AS cpu_quota_cores,
        CAST(SUBSTRING_INDEX(GROUP_CONCAT(net_rx_last ORDER BY bucket_start DESC), ',', 1) AS UNSIGNED) AS net_rx_last,
        CAST(SUBSTRING_INDEX(GROUP_CONCAT(net_tx_last ORDER BY bucket_start DESC), ',', 1) AS UNSIGNED) AS net_tx_last
      FROM metric_container_samples
      WHERE entity_id = ?
        AND bucket_start >= ?
        AND bucket_start < ?
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    [container.id, fromStr, toStr],
  )

  // Percentile aggregates need per-minute values; keyed by bucket for merge.
  let percentileByBucket: Map<string, number | null> | null = null
  if (isPercentileAgg(agg)) {
    const [minuteRows] = await pool.query<ContainerMinuteRow[]>(
      `
        SELECT bucket_start, cpu_pct_sum, mem_used_sum, sample_count
        FROM metric_container_samples
        WHERE entity_id = ?
          AND bucket_start >= ?
          AND bucket_start < ?
        ORDER BY bucket_start ASC
      `,
      [container.id, fromStr, toStr],
    )
    const percentilePts = percentilePoints(minuteRows, granularity, metric, agg, (row) => {
      const count = Number(row.sample_count) || 0
      const sum = metric === 'memory' ? Number(row.mem_used_sum) : Number(row.cpu_pct_sum)
      return count ? sum / count : null
    })
    percentileByBucket = new Map(
      percentilePts.map((point) => [
        point.bucket_start,
        metric === 'memory' ? point.avg_bytes ?? null : point.avg,
      ]),
    )
  }

  let prevRx: number | null = null
  let prevTx: number | null = null
  let prevTime: number | null = null

  const points: TimeseriesPoint[] = rows.map((row) => {
    const bucketTime = new Date(`${row.bucket_start.replace(' ', 'T')}Z`).getTime()
    const deltaSeconds = prevTime == null ? null : (bucketTime - prevTime) / 1000

    const rx = row.net_rx_last == null ? null : Number(row.net_rx_last)
    const tx = row.net_tx_last == null ? null : Number(row.net_tx_last)

    let netRxBps: number | null = null
    let netTxBps: number | null = null
    if (deltaSeconds && deltaSeconds > 0) {
      if (rx != null && prevRx != null) {
        const delta = rx - prevRx
        netRxBps = (delta < 0 ? rx : delta) / deltaSeconds
      }
      if (tx != null && prevTx != null) {
        const delta = tx - prevTx
        netTxBps = (delta < 0 ? tx : delta) / deltaSeconds
      }
    }

    prevRx = rx
    prevTx = tx
    prevTime = bucketTime

    const count = row.sample_count == null ? null : Number(row.sample_count)
    const limit = row.mem_limit_bytes == null ? null : Number(row.mem_limit_bytes)
    const reference = metric === 'memory' ? limit : null

    let value: number | null
    if (percentileByBucket) {
      value = percentileByBucket.get(row.bucket_start) ?? null
    } else if (metric === 'memory') {
      const sum = row.mem_sum == null ? null : Number(row.mem_sum)
      value = pickAgg(agg, {
        avg: sum != null && count ? sum / count : null,
        sum,
        count,
        max: row.mem_max == null ? null : Number(row.mem_max),
      })
    } else {
      const sum = row.cpu_sum == null ? null : Number(row.cpu_sum)
      value = pickAgg(agg, {
        avg: sum != null && count ? sum / count : null,
        sum,
        count,
        max: row.cpu_max == null ? null : Number(row.cpu_max),
      })
    }

    const point = buildScalarPoint(row.bucket_start, metric, agg, value, reference)
    point.net_rx_bps = netRxBps
    point.net_tx_bps = netTxBps
    return point
  })

  return {
    container: {
      container_key: container.container_key,
      name: container.name,
      task_name: container.task_name,
      cpu_quota_cores: container.cpu_quota_cores == null ? null : Number(container.cpu_quota_cores),
      mem_limit_bytes: container.mem_limit_bytes == null ? null : Number(container.mem_limit_bytes),
    },
    points,
  }
}

// ---------------------------------------------------------------------------
// Alert rules CRUD
// ---------------------------------------------------------------------------

export interface MetricAlertRuleRow extends RowDataPacket {
  id: number
  scope: MetricScope
  target_key: string | null
  metric: MetricKind
  operator: MetricOperator
  threshold_pct: number
  sustained_minutes: number
  cooldown_minutes: number
  enabled: number
  created_at: Date | string
  updated_at: Date | string
}

export const serializeAlertRule = (row: MetricAlertRuleRow) => ({
  id: row.id,
  scope: row.scope,
  target_key: row.target_key,
  metric: row.metric,
  operator: row.operator,
  threshold_pct: Number(row.threshold_pct),
  sustained_minutes: Number(row.sustained_minutes),
  cooldown_minutes: Number(row.cooldown_minutes),
  enabled: Number(row.enabled) === 1,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

export async function listAlertRules(): Promise<MetricAlertRuleRow[]> {
  const [rows] = await pool.query<MetricAlertRuleRow[]>(
    'SELECT * FROM metric_alert_rules ORDER BY id ASC',
  )
  return rows
}

export async function getAlertRule(id: number): Promise<MetricAlertRuleRow | null> {
  const [rows] = await pool.query<MetricAlertRuleRow[]>(
    'SELECT * FROM metric_alert_rules WHERE id = ? LIMIT 1',
    [id],
  )
  return rows[0] ?? null
}

export type AlertRuleInput = {
  scope: MetricScope
  target_key: string | null
  metric: MetricKind
  operator: MetricOperator
  threshold_pct: number
  sustained_minutes: number
  cooldown_minutes: number
  enabled: boolean
}

export function normalizeAlertRuleInput(payload: Record<string, unknown>): AlertRuleInput {
  const scope = String(payload.scope ?? '').trim().toLowerCase() as MetricScope
  if (!METRIC_SCOPES.has(scope)) {
    throw new Error('scope must be one of node, service, container')
  }

  const metric = String(payload.metric ?? '').trim().toLowerCase() as MetricKind
  if (!METRIC_KINDS.has(metric)) {
    throw new Error('metric must be one of cpu, memory')
  }

  const operator = String(payload.operator ?? '>').trim() as MetricOperator
  if (!METRIC_OPERATORS.has(operator)) {
    throw new Error('operator must be one of >, >=, <, <=')
  }

  const thresholdPct = Number(payload.threshold_pct)
  if (!Number.isFinite(thresholdPct)) {
    throw new Error('threshold_pct must be a number')
  }

  const targetKeyRaw = payload.target_key == null ? '' : String(payload.target_key).trim()
  const targetKey = targetKeyRaw === '' ? null : targetKeyRaw

  const sustainedMinutes = Number(payload.sustained_minutes ?? 5)
  if (!Number.isInteger(sustainedMinutes) || sustainedMinutes < 1) {
    throw new Error('sustained_minutes must be a positive integer')
  }

  const cooldownMinutes = Number(payload.cooldown_minutes ?? 30)
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0) {
    throw new Error('cooldown_minutes must be a non-negative integer')
  }

  return {
    scope,
    target_key: targetKey,
    metric,
    operator,
    threshold_pct: thresholdPct,
    sustained_minutes: sustainedMinutes,
    cooldown_minutes: cooldownMinutes,
    enabled: payload.enabled == null ? true : Boolean(payload.enabled),
  }
}

export async function createAlertRule(input: AlertRuleInput): Promise<MetricAlertRuleRow> {
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO metric_alert_rules
        (scope, target_key, metric, operator, threshold_pct, sustained_minutes, cooldown_minutes, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.scope,
      input.target_key,
      input.metric,
      input.operator,
      input.threshold_pct,
      input.sustained_minutes,
      input.cooldown_minutes,
      input.enabled ? 1 : 0,
    ],
  )
  const created = await getAlertRule(result.insertId)
  return created!
}

export async function updateAlertRule(
  id: number,
  input: AlertRuleInput,
): Promise<MetricAlertRuleRow | null> {
  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE metric_alert_rules
      SET
        scope = ?,
        target_key = ?,
        metric = ?,
        operator = ?,
        threshold_pct = ?,
        sustained_minutes = ?,
        cooldown_minutes = ?,
        enabled = ?
      WHERE id = ?
    `,
    [
      input.scope,
      input.target_key,
      input.metric,
      input.operator,
      input.threshold_pct,
      input.sustained_minutes,
      input.cooldown_minutes,
      input.enabled ? 1 : 0,
      id,
    ],
  )
  if (!result.affectedRows) return null
  // A scope/target change orphans old state rows; drop them so we start clean.
  await pool.query('DELETE FROM metric_alert_state WHERE rule_id = ?', [id])
  return getAlertRule(id)
}

export async function deleteAlertRule(id: number): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    'DELETE FROM metric_alert_rules WHERE id = ?',
    [id],
  )
  return Boolean(result.affectedRows)
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

const compare = (value: number, threshold: number, operator: MetricOperator): boolean => {
  if (operator === '>') return value > threshold
  if (operator === '>=') return value >= threshold
  if (operator === '<') return value < threshold
  return value <= threshold
}

type ResolvedEntity = {
  entityKey: string
  entityId: number
  label: string
}

const resolveEntities = async (rule: MetricAlertRuleRow): Promise<ResolvedEntity[]> => {
  if (rule.scope === 'node') {
    const params: unknown[] = []
    let filter = 'last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)'
    params.push(ALERT_LIVE_WINDOW_MINUTES)
    if (rule.target_key) {
      filter = 'node_key = ?'
      params.length = 0
      params.push(rule.target_key)
    }
    const [rows] = await pool.query<({ id: number; node_key: string; hostname: string | null } & RowDataPacket)[]>(
      `SELECT id, node_key, hostname FROM metric_nodes WHERE ${filter}`,
      params,
    )
    return rows.map((row) => ({
      entityKey: row.node_key,
      entityId: row.id,
      label: row.hostname ?? row.node_key,
    }))
  }

  if (rule.scope === 'service') {
    const params: unknown[] = []
    let filter = 'last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)'
    params.push(ALERT_LIVE_WINDOW_MINUTES)
    if (rule.target_key) {
      filter = 'service_name = ?'
      params.length = 0
      params.push(rule.target_key)
    }
    const [rows] = await pool.query<({ id: number; service_name: string } & RowDataPacket)[]>(
      `SELECT id, service_name FROM metric_services WHERE ${filter}`,
      params,
    )
    return rows.map((row) => ({
      entityKey: row.service_name,
      entityId: row.id,
      label: row.service_name,
    }))
  }

  const params: unknown[] = []
  let filter = 'last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)'
  params.push(ALERT_LIVE_WINDOW_MINUTES)
  if (rule.target_key) {
    filter = 'container_key = ?'
    params.length = 0
    params.push(rule.target_key)
  }
  const [rows] = await pool.query<({ id: number; container_key: string; name: string | null } & RowDataPacket)[]>(
    `SELECT id, container_key, name FROM metric_containers WHERE ${filter}`,
    params,
  )
  return rows.map((row) => ({
    entityKey: row.container_key,
    entityId: row.id,
    label: row.name ?? row.container_key,
  }))
}

// Returns the per-minute values (newest first) for the entity over the window,
// or null entries where the metric can't be computed for that minute.
const entityWindowValues = async (
  rule: MetricAlertRuleRow,
  entity: ResolvedEntity,
): Promise<Array<number | null>> => {
  const limit = rule.sustained_minutes

  if (rule.scope === 'node') {
    const [rows] = await pool.query<
      ({ bucket_start: string; cpu_pct_sum: number; sample_count: number; mem_used_sum: number; mem_total_last: number | null } & RowDataPacket)[]
    >(
      `
        SELECT bucket_start, cpu_pct_sum, sample_count, mem_used_sum, mem_total_last
        FROM metric_node_samples
        WHERE entity_id = ?
        ORDER BY bucket_start DESC
        LIMIT ?
      `,
      [entity.entityId, limit],
    )
    if (!isWindowFresh(rows[0]?.bucket_start)) return []
    return rows.map((row) => {
      if (rule.metric === 'memory') {
        const total = row.mem_total_last == null ? null : Number(row.mem_total_last)
        return total ? (Number(row.mem_used_sum) / Number(row.sample_count) / total) * 100 : null
      }
      return Number(row.cpu_pct_sum) / Number(row.sample_count)
    })
  }

  if (rule.scope === 'container') {
    const [rows] = await pool.query<
      ({ bucket_start: string; cpu_pct_sum: number; sample_count: number; mem_used_sum: number; cpu_quota_cores_last: number | null; mem_limit_bytes_last: number | null } & RowDataPacket)[]
    >(
      `
        SELECT bucket_start, cpu_pct_sum, sample_count, mem_used_sum, cpu_quota_cores_last, mem_limit_bytes_last
        FROM metric_container_samples
        WHERE entity_id = ?
        ORDER BY bucket_start DESC
        LIMIT ?
      `,
      [entity.entityId, limit],
    )
    if (!isWindowFresh(rows[0]?.bucket_start)) return []
    return rows.map((row) => {
      const cpuPct = Number(row.cpu_pct_sum) / Number(row.sample_count)
      if (rule.metric === 'memory') {
        const limitBytes = row.mem_limit_bytes_last == null ? null : Number(row.mem_limit_bytes_last)
        return limitBytes ? (Number(row.mem_used_sum) / Number(row.sample_count) / limitBytes) * 100 : null
      }
      // Prefer % of allotted quota when a quota is set, else raw cpu_pct.
      const quota = row.cpu_quota_cores_last == null ? null : Number(row.cpu_quota_cores_last)
      return quota ? cpuPct / quota : cpuPct
    })
  }

  // service scope: aggregate across replicas per minute
  const [rows] = await pool.query<
    ({ bucket_start: string; cpu_avg: number | null; mem_used_total: number | null; mem_limit_total: number | null; null_limits: number } & RowDataPacket)[]
  >(
    `
      SELECT
        cs.bucket_start AS bucket_start,
        SUM(cs.cpu_pct_sum) / SUM(cs.sample_count) AS cpu_avg,
        SUM(cs.mem_used_sum / cs.sample_count) AS mem_used_total,
        SUM(cs.mem_limit_bytes_last) AS mem_limit_total,
        SUM(CASE WHEN cs.mem_limit_bytes_last IS NULL THEN 1 ELSE 0 END) AS null_limits
      FROM metric_container_samples cs
      JOIN metric_containers c ON c.id = cs.entity_id
      WHERE c.service_id = ?
      GROUP BY cs.bucket_start
      ORDER BY cs.bucket_start DESC
      LIMIT ?
    `,
    [entity.entityId, limit],
  )
  if (!isWindowFresh(rows[0]?.bucket_start)) return []
  return rows.map((row) => {
    if (rule.metric === 'memory') {
      // Only a valid % when every replica reports a limit.
      if (Number(row.null_limits) > 0) return null
      const limitTotal = row.mem_limit_total == null ? null : Number(row.mem_limit_total)
      return limitTotal ? (Number(row.mem_used_total) / limitTotal) * 100 : null
    }
    return toFiniteOrNull(row.cpu_avg)
  })
}

const isWindowFresh = (newestBucket: string | undefined): boolean => {
  if (!newestBucket) return false
  const bucketTime = new Date(`${newestBucket.replace(' ', 'T')}Z`).getTime()
  return Date.now() - bucketTime <= ALERT_STALE_MINUTES * 60 * 1000
}

interface AlertStateRow extends RowDataPacket {
  rule_id: number
  entity_key: string
  status: 'ok' | 'firing'
  breaching_since: Date | string | null
  last_notified_at: Date | string | null
  last_metric_value: number | null
}

const evaluateRule = async (rule: MetricAlertRuleRow): Promise<void> => {
  const entities = await resolveEntities(rule)
  if (!entities.length) return

  const [stateRows] = await pool.query<AlertStateRow[]>(
    'SELECT * FROM metric_alert_state WHERE rule_id = ?',
    [rule.id],
  )
  const stateByEntity = new Map<string, AlertStateRow>()
  for (const row of stateRows) stateByEntity.set(row.entity_key, row)

  for (const entity of entities) {
    const values = await entityWindowValues(rule, entity)
    const windowFull = values.length >= rule.sustained_minutes
    const allBreach =
      windowFull && values.every((value) => value != null && compare(value, rule.threshold_pct, rule.operator))
    const latestValue = values.find((value) => value != null) ?? null

    const prior = stateByEntity.get(entity.entityKey)
    const priorStatus = prior?.status ?? 'ok'
    const lastNotifiedAt = prior?.last_notified_at ? new Date(prior.last_notified_at).getTime() : 0
    const cooldownMs = rule.cooldown_minutes * 60 * 1000
    const now = Date.now()

    if (allBreach && priorStatus !== 'firing') {
      const withinCooldown = lastNotifiedAt > 0 && now - lastNotifiedAt < cooldownMs
      let notifiedAt = lastNotifiedAt > 0 ? toSqlDateTime(new Date(lastNotifiedAt)) : null
      if (!withinCooldown) {
        await sendAlert(rule, entity, latestValue, 'FIRING')
        notifiedAt = toSqlDateTime(new Date())
      }
      await upsertAlertState(rule.id, entity.entityKey, 'firing', toSqlDateTime(new Date()), notifiedAt, latestValue)
    } else if (!allBreach && priorStatus === 'firing') {
      await sendAlert(rule, entity, latestValue, 'RESOLVED')
      await upsertAlertState(
        rule.id,
        entity.entityKey,
        'ok',
        null,
        toSqlDateTime(new Date()),
        latestValue,
      )
    } else if (prior) {
      await pool.query('UPDATE metric_alert_state SET last_metric_value = ? WHERE rule_id = ? AND entity_key = ?', [
        latestValue,
        rule.id,
        entity.entityKey,
      ])
    } else {
      await upsertAlertState(rule.id, entity.entityKey, 'ok', null, null, latestValue)
    }
  }
}

const upsertAlertState = async (
  ruleId: number,
  entityKey: string,
  status: 'ok' | 'firing',
  breachingSince: string | null,
  lastNotifiedAt: string | null,
  lastValue: number | null,
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO metric_alert_state
        (rule_id, entity_key, status, breaching_since, last_notified_at, last_metric_value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        breaching_since = VALUES(breaching_since),
        last_notified_at = VALUES(last_notified_at),
        last_metric_value = VALUES(last_metric_value)
    `,
    [ruleId, entityKey, status, breachingSince, lastNotifiedAt, lastValue],
  )
}

const sendAlert = async (
  rule: MetricAlertRuleRow,
  entity: ResolvedEntity,
  value: number | null,
  state: 'FIRING' | 'RESOLVED',
): Promise<void> => {
  await notifyMetricAlert({
    ruleId: rule.id,
    scope: rule.scope,
    target: entity.entityKey,
    targetLabel: entity.label,
    metric: rule.metric,
    operator: rule.operator,
    value,
    threshold: Number(rule.threshold_pct),
    sustainedMinutes: Number(rule.sustained_minutes),
    state,
  })
}

const evaluateAlerts = async (): Promise<void> => {
  const [rules] = await pool.query<MetricAlertRuleRow[]>(
    'SELECT * FROM metric_alert_rules WHERE enabled = 1',
  )
  for (const rule of rules) {
    try {
      await evaluateRule(rule)
    } catch (error) {
      console.error(
        `[metrics] alert rule=${rule.id} evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Retention + dimension pruning
// ---------------------------------------------------------------------------

const runRetention = async (): Promise<void> => {
  const retentionDays = config.metrics.retentionDays
  const pruneDays = config.metrics.dimensionPruneDays

  await pool.query(
    'DELETE FROM metric_node_samples WHERE bucket_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
    [retentionDays],
  )
  await pool.query(
    'DELETE FROM metric_container_samples WHERE bucket_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
    [retentionDays],
  )

  // Prune stale containers (and their samples), then orphan services/nodes.
  await pool.query(
    `
      DELETE s FROM metric_container_samples s
      JOIN metric_containers c ON c.id = s.entity_id
      WHERE c.last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
    `,
    [pruneDays],
  )
  await pool.query(
    'DELETE FROM metric_containers WHERE last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
    [pruneDays],
  )
  await pool.query(
    `
      DELETE FROM metric_services
      WHERE id NOT IN (SELECT service_id FROM metric_containers WHERE service_id IS NOT NULL)
    `,
  )
  await pool.query(
    `
      DELETE s FROM metric_node_samples s
      JOIN metric_nodes n ON n.id = s.entity_id
      WHERE n.id NOT IN (SELECT node_id FROM metric_containers WHERE node_id IS NOT NULL)
        AND n.last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
    `,
    [pruneDays],
  )
  await pool.query(
    `
      DELETE FROM metric_nodes
      WHERE id NOT IN (SELECT node_id FROM metric_containers WHERE node_id IS NOT NULL)
        AND last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
    `,
    [pruneDays],
  )

  nodeIdCache.clear()
  serviceIdCache.clear()
  containerIdCache.clear()
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  if (isTickRunning) return
  isTickRunning = true

  try {
    if (Date.now() - lastRetentionCleanupAt >= RETENTION_CLEANUP_INTERVAL_MS) {
      await runRetention()
      lastRetentionCleanupAt = Date.now()
    }

    if (Date.now() - lastAlertAt >= config.metrics.alertPollMs) {
      await evaluateAlerts()
      lastAlertAt = Date.now()
    }
  } catch (error) {
    console.error('[metrics] tick failed:', error)
  } finally {
    isTickRunning = false
  }
}

export function startMetricsService(): void {
  if (timer) return

  if (!config.metrics.ingestToken) {
    console.warn('[metrics] METRICS_INGEST_TOKEN is not set; ingest endpoint returns 503')
  }

  // Run the first retention sweep on startup, then hourly checks against the
  // 6h/60s intervals inside tick().
  lastRetentionCleanupAt = Date.now() - RETENTION_CLEANUP_INTERVAL_MS
  timer = setInterval(() => {
    void tick()
  }, config.metrics.alertPollMs)
  void tick()
}

export function stopMetricsService(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
