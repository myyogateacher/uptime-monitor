import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import {
  CONTAINER_SAMPLES_TABLE,
  NODE_SAMPLES_TABLE,
  chCommandDetached,
  chInsert,
  chSelect,
  isClickhouseReady,
  toEpochSeconds,
  toNullableFloat,
  toNullableUInt,
  toUInt,
} from './clickhouse'
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
// The window is pushed to ClickHouse as Unix epoch seconds; bucket labels come
// back as 'YYYY-MM-DD HH:MM:SS' UTC strings, exactly as before.
export type MetricWindow = { from: Date; to: Date }

// Aggregation ("group by") applied when bucketing the ClickHouse raw samples.
// Every aggregate — including real p95/p99 quantiles over the raw sample
// values — is computed in ClickHouse; nothing is approximated in JS.
export type MetricAgg = 'avg' | 'sum' | 'count' | 'max' | 'p95' | 'p99'
export const METRIC_AGGS = new Set<MetricAgg>([
  'avg',
  'sum',
  'count',
  'max',
  'p95',
  'p99',
])

// Parses a ClickHouse JSON scalar. UInt64 columns arrive as strings and empty
// aggregates as null/NaN, so anything non-finite collapses to null.
const chNumber = (value: unknown): number | null => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// container_id is UInt32 in ClickHouse. Bounding ids to that range also keeps
// String() from emitting exponential notation for absurdly large values.
const UINT32_MAX = 4294967295

// Renders an id list for inlining into SQL text.
//
// These lists must NOT be passed as bound {x:Array(UInt32)} params:
// @clickhouse/client serializes bound params into the request's URL query
// string, so a service with many accumulated task generations produced a URL
// long enough for nginx to reject with 414 Request-URI Too Large.
//
// The values are MySQL auto-increment ids, never user input, but they are
// validated defensively anyway — anything non-integer would otherwise be
// concatenated straight into the query. Callers must guard against empty
// input; an empty list has no valid SQL rendering, so it throws.
const toIntListSql = (values: number[]): string => {
  const parts = values.map((value) => {
    const parsed = value == null ? NaN : Number(value)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > UINT32_MAX) {
      throw new Error(`Expected a UInt32 id, received: ${String(value)}`)
    }
    return String(parsed)
  })
  if (!parts.length) throw new Error('Expected at least one id')
  return parts.join(',')
}

// Bucketing is always evaluated in UTC so results never depend on the
// ClickHouse server's local timezone.
const bucketOf = (granularity: MetricGranularity, column = 'ts'): string => {
  if (granularity === 'hour') return `toStartOfHour(${column}, 'UTC')`
  if (granularity === 'day') return `toStartOfDay(${column}, 'UTC')`
  return `toStartOfMinute(${column}, 'UTC')`
}

// Renders the bucket as the exact 'YYYY-MM-DD HH:MM:SS' string the MySQL
// implementation returned, so bucket_start stays byte-identical for clients.
const bucketStartExpr = (granularity: MetricGranularity, column = 'ts'): string =>
  `formatDateTime(${bucketOf(granularity, column)}, '%Y-%m-%d %H:%i:%S', 'UTC')`

const MINUTE_START_EXPR = `formatDateTime(toStartOfMinute(ts, 'UTC'), '%Y-%m-%d %H:%i:%S', 'UTC')`

// Builds the per-bucket aggregate expression. `value` is the raw sample column
// (or a pre-aggregated per-minute total for service queries); `max`/`count`
// override the column used by those two aggregates when the caller already
// aggregated one level down.
const aggExprOver = (
  agg: MetricAgg,
  columns: { value: string; max?: string; count?: string },
): string => {
  switch (agg) {
    case 'sum':
      return `sum(${columns.value})`
    case 'count':
      return columns.count ? `sum(${columns.count})` : 'count()'
    case 'max':
      return `max(${columns.max ?? columns.value})`
    case 'p95':
      return `quantile(0.95)(${columns.value})`
    case 'p99':
      return `quantile(0.99)(${columns.value})`
    default:
      return `avg(${columns.value})`
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

// Raw sample writes go to ClickHouse. Timestamps are sent as Unix epoch
// seconds so the value is timezone-independent on the wire. A failure throws
// (ClickhouseQueryError / ClickhouseUnavailableError) and the ingest route
// answers 5xx so the sidecar's ring buffer replays the batch — never a silent
// drop.
const insertNodeSample = async (
  nodeId: number,
  collectedAt: Date,
  node: NodeInfo,
): Promise<void> => {
  // cpu_pct is null on the collector's first tick; skip so averages over the
  // raw samples are not dragged toward zero.
  if (node.cpu_pct == null) return

  await chInsert(NODE_SAMPLES_TABLE, [
    {
      node_id: nodeId,
      ts: toEpochSeconds(collectedAt),
      cpu_pct: Number(node.cpu_pct),
      mem_used: toUInt(node.mem_used_bytes),
      mem_total: toUInt(node.mem_total_bytes),
    },
  ])
}

const insertContainerSamples = async (
  containers: ContainerMetrics[],
  collectedAt: Date,
  nodeId: number,
): Promise<void> => {
  const ts = toEpochSeconds(collectedAt)
  const rows: Record<string, unknown>[] = []

  for (const container of containers) {
    const entityId = containerIdCache.get(container.container_id)
    if (entityId == null) continue
    rows.push({
      container_id: entityId,
      // Denormalized dimensions: they let service/node queries filter without a
      // container-id list. 0 = unknown, matching the column default.
      service_id: container.service_name
        ? (serviceIdCache.get(container.service_name) ?? 0)
        : 0,
      node_id: nodeId,
      ts,
      cpu_pct: Number(container.cpu_pct) || 0,
      mem_used: toUInt(container.mem_used_bytes),
      mem_limit: toNullableUInt(container.mem_limit_bytes),
      cpu_quota_cores: toNullableFloat(container.cpu_quota_cores),
      net_rx: toUInt(container.net_rx_bytes),
      net_tx: toUInt(container.net_tx_bytes),
    })
  }

  await chInsert(CONTAINER_SAMPLES_TABLE, rows)
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

  await insertNodeSample(nodeId, collectedAt, node)
  await insertContainerSamples(containers, collectedAt, nodeId)

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

// Latest-value lookups only consider samples from the last LIVE_WINDOW_MINUTES,
// which is also how "live" is defined for dimension rows (last_seen). Stale
// Swarm task generations therefore never inflate replica counts or totals,
// while their history stays queryable through the per-container endpoints.
const LIVE_WINDOW_MINUTES = 10

const liveWindowStart = (): number =>
  toEpochSeconds(new Date(Date.now() - LIVE_WINDOW_MINUTES * 60 * 1000))

type NodeOverviewRow = {
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

type ServiceOverviewRow = {
  service_name: string
  container_count: number
  node_count: number
  cpu_pct_total: number | null
  mem_used_total: number | null
  // Window-aggregated companions to the two live values above. Null unless the
  // caller asked for an aggregate window (see ServiceAggWindow).
  cpu_pct_total_agg: number | null
  mem_used_agg: number | null
  total_quota_cores: number | null
  total_mem_limit_bytes: number | null
  last_seen: Date | string | null
}

// Opt-in request for the window-aggregated per-service values. Omitted by
// callers that only need the live snapshot (keeps the extra query off the
// default overview path).
export type ServiceAggWindow = { agg: MetricAgg; window: MetricWindow }

interface NodeDimensionRow extends RowDataPacket {
  id: number
  node_key: string
  hostname: string | null
  cpu_cores: number | null
  mem_total_bytes: number | null
  last_seen: Date | string | null
  container_count: number | null
}

type ChLatestNodeRow = {
  node_id: number | string
  bucket_start: string
  cpu_pct: number | string | null
  cpu_pct_max: number | string | null
  mem_used_bytes: number | string | null
  mem_total_last: number | string | null
}

type ChLatestContainerRow = {
  container_id: number | string
  bucket_start: string
  cpu_pct: number | string | null
  cpu_pct_max: number | string | null
  mem_used_bytes: number | string | null
}

// Newest minute bucket per node within the live window (ClickHouse). Mirrors
// the previous "latest rollup row" semantics: the value is the average over
// that minute's raw samples, cpu_pct_max the max within it.
const latestNodeStats = async (): Promise<Map<number, ChLatestNodeRow>> => {
  const rows = await chSelect<ChLatestNodeRow>(
    `
      SELECT
        node_id,
        ${MINUTE_START_EXPR} AS bucket_start,
        avg(cpu_pct) AS cpu_pct,
        max(cpu_pct) AS cpu_pct_max,
        avg(mem_used) AS mem_used_bytes,
        max(mem_total) AS mem_total_last
      FROM ${NODE_SAMPLES_TABLE}
      WHERE ts >= toDateTime({from:UInt32})
      GROUP BY node_id, bucket_start
      ORDER BY node_id ASC, bucket_start DESC
      LIMIT 1 BY node_id
    `,
    { from: liveWindowStart() },
  )
  return new Map(rows.map((row) => [Number(row.node_id), row]))
}

// Newest minute bucket per container within the live window (ClickHouse).
const latestContainerStats = async (): Promise<Map<number, ChLatestContainerRow>> => {
  const rows = await chSelect<ChLatestContainerRow>(
    `
      SELECT
        container_id,
        ${MINUTE_START_EXPR} AS bucket_start,
        avg(cpu_pct) AS cpu_pct,
        max(cpu_pct) AS cpu_pct_max,
        avg(mem_used) AS mem_used_bytes
      FROM ${CONTAINER_SAMPLES_TABLE}
      WHERE ts >= toDateTime({from:UInt32})
      GROUP BY container_id, bucket_start
      ORDER BY container_id ASC, bucket_start DESC
      LIMIT 1 BY container_id
    `,
    { from: liveWindowStart() },
  )
  return new Map(rows.map((row) => [Number(row.container_id), row]))
}

const listNodesQuery = async (): Promise<NodeOverviewRow[]> => {
  const [dimensions] = await pool.query<NodeDimensionRow[]>(
    `
      SELECT
        n.id,
        n.node_key,
        n.hostname,
        n.cpu_cores,
        n.mem_total_bytes,
        n.last_seen,
        (
          SELECT COUNT(*)
          FROM metric_containers mc
          WHERE mc.node_id = n.id
            AND mc.last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
        ) AS container_count
      FROM metric_nodes n
      ORDER BY n.hostname ASC, n.node_key ASC
    `,
    [LIVE_WINDOW_MINUTES],
  )

  const latest = await latestNodeStats()

  return dimensions.map((row) => {
    const sample = latest.get(row.id)
    return {
      node_key: row.node_key,
      hostname: row.hostname,
      cpu_cores: row.cpu_cores,
      mem_total_bytes: row.mem_total_bytes,
      last_seen: row.last_seen,
      bucket_start: sample?.bucket_start ?? null,
      cpu_pct: sample ? chNumber(sample.cpu_pct) : null,
      cpu_pct_max: sample ? chNumber(sample.cpu_pct_max) : null,
      mem_used_bytes: sample ? chNumber(sample.mem_used_bytes) : null,
      mem_total_last: sample ? chNumber(sample.mem_total_last) : null,
      container_count: row.container_count,
    }
  })
}

interface ServiceContainerDimensionRow extends RowDataPacket {
  service_id: number
  service_name: string
  container_id: number
  node_id: number | null
  cpu_quota_cores: number | null
  mem_limit_bytes: number | null
  last_seen: Date | string | null
  is_live: number
}

type ChServiceAggRow = {
  service_id: string | number
  cpu_value: unknown
  mem_value: unknown
}

// Window aggregate for every service in one ClickHouse round-trip.
//
// Filters on the denormalized service_id, so the only list crossing the wire is
// the set of service ids — bounded by the number of services, not by the number
// of container generations ever deployed.
//
// Three levels, matching getServiceTimeseries() exactly except that the outer
// level collapses the whole window into one row per service instead of
// re-bucketing to a granularity:
//   inner  – per container, per minute (avg / max / sample count)
//   middle – per minute totals across the service's replicas
//   outer  – the requested agg over those per-minute totals
//
// `nodeId`, when set, restricts the aggregate to that node's replicas so the
// By-Node view keeps meaning "this node's share of the service".
const serviceWindowAggregates = async (
  serviceIds: Map<number, string>,
  { agg, window }: ServiceAggWindow,
  nodeId?: number,
): Promise<Map<string, { cpu: number | null; mem: number | null }>> => {
  const result = new Map<string, { cpu: number | null; mem: number | null }>()
  if (!serviceIds.size) return result

  const rows = await chSelect<ChServiceAggRow>(
    `
      SELECT
        service_id,
        ${aggExprOver(agg, { value: 'cpu_total', max: 'cpu_max_total', count: 'sample_count' })} AS cpu_value,
        ${aggExprOver(agg, { value: 'mem_total', max: 'mem_max_total', count: 'sample_count' })} AS mem_value
      FROM (
        SELECT
          service_id,
          minute,
          sum(cpu_avg) AS cpu_total,
          sum(cpu_max) AS cpu_max_total,
          sum(mem_avg) AS mem_total,
          sum(mem_max) AS mem_max_total,
          sum(container_samples) AS sample_count
        FROM (
          SELECT
            service_id,
            toStartOfMinute(ts, 'UTC') AS minute,
            avg(cpu_pct) AS cpu_avg,
            max(cpu_pct) AS cpu_max,
            avg(mem_used) AS mem_avg,
            max(mem_used) AS mem_max,
            count() AS container_samples
          FROM ${CONTAINER_SAMPLES_TABLE}
          WHERE service_id IN (${toIntListSql([...serviceIds.keys()])})
            ${nodeId == null ? '' : 'AND node_id = {node_id:UInt32}'}
            AND ts >= toDateTime({from:UInt32})
            AND ts < toDateTime({to:UInt32})
          GROUP BY service_id, container_id, minute
        )
        GROUP BY service_id, minute
      )
      GROUP BY service_id
    `,
    {
      from: toEpochSeconds(window.from),
      to: toEpochSeconds(window.to),
      ...(nodeId == null ? {} : { node_id: nodeId }),
    },
  )

  for (const row of rows) {
    const name = serviceIds.get(Number(row.service_id))
    if (name == null) continue
    result.set(name, { cpu: chNumber(row.cpu_value), mem: chNumber(row.mem_value) })
  }
  return result
}

const listServicesQuery = async (
  nodeKey?: string,
  aggWindow?: ServiceAggWindow,
): Promise<ServiceOverviewRow[]> => {
  const params: unknown[] = [LIVE_WINDOW_MINUTES]
  let nodeFilter = ''
  if (nodeKey) {
    nodeFilter = 'AND n.node_key = ?'
    params.push(nodeKey)
  }

  // Dimension rows stay in MySQL. Every container of the service is listed so
  // last_seen keeps its "most recent replica generation" meaning, but counts
  // and totals below only consider the live ones.
  const [rows] = await pool.query<ServiceContainerDimensionRow[]>(
    `
      SELECT
        sv.id AS service_id,
        sv.service_name,
        c.id AS container_id,
        c.node_id,
        c.cpu_quota_cores,
        c.mem_limit_bytes,
        c.last_seen,
        (c.last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)) AS is_live
      FROM metric_services sv
      JOIN metric_containers c ON c.service_id = sv.id
      LEFT JOIN metric_nodes n ON n.id = c.node_id
      WHERE 1 = 1 ${nodeFilter}
      ORDER BY sv.service_name ASC
    `,
    params,
  )
  if (!rows.length) return []

  // The window aggregate is keyed by service id; only the services visible here
  // are queried, and the node filter is reapplied inside ClickHouse so the
  // By-Node view still reports that node's share.
  const serviceIds = new Map<number, string>()
  for (const row of rows) serviceIds.set(Number(row.service_id), row.service_name)
  const aggNodeId =
    nodeKey && rows[0]?.node_id != null ? Number(rows[0].node_id) : undefined

  const [latest, aggregates] = await Promise.all([
    latestContainerStats(),
    aggWindow
      ? serviceWindowAggregates(serviceIds, aggWindow, aggNodeId)
      : Promise.resolve(new Map<string, { cpu: number | null; mem: number | null }>()),
  ])

  type Accumulator = {
    service_name: string
    liveContainers: number
    liveNodes: Set<number>
    cpuTotal: number | null
    memTotal: number | null
    quotaTotal: number | null
    memLimitTotal: number | null
    lastSeen: Date | string | null
  }

  const byService = new Map<string, Accumulator>()
  for (const row of rows) {
    let entry = byService.get(row.service_name)
    if (!entry) {
      entry = {
        service_name: row.service_name,
        liveContainers: 0,
        liveNodes: new Set<number>(),
        cpuTotal: null,
        memTotal: null,
        quotaTotal: null,
        memLimitTotal: null,
        lastSeen: null,
      }
      byService.set(row.service_name, entry)
    }

    if (row.last_seen != null) {
      const current = entry.lastSeen == null ? null : new Date(entry.lastSeen).getTime()
      const candidate = new Date(row.last_seen).getTime()
      if (current == null || candidate > current) entry.lastSeen = row.last_seen
    }

    if (!Number(row.is_live)) continue

    entry.liveContainers += 1
    if (row.node_id != null) entry.liveNodes.add(Number(row.node_id))
    if (row.cpu_quota_cores != null) {
      entry.quotaTotal = (entry.quotaTotal ?? 0) + Number(row.cpu_quota_cores)
    }
    if (row.mem_limit_bytes != null) {
      entry.memLimitTotal = (entry.memLimitTotal ?? 0) + Number(row.mem_limit_bytes)
    }

    const sample = latest.get(Number(row.container_id))
    if (!sample) continue
    const cpu = chNumber(sample.cpu_pct)
    if (cpu != null) entry.cpuTotal = (entry.cpuTotal ?? 0) + cpu
    const mem = chNumber(sample.mem_used_bytes)
    if (mem != null) entry.memTotal = (entry.memTotal ?? 0) + mem
  }

  return [...byService.values()]
    .sort((left, right) => (left.service_name < right.service_name ? -1 : left.service_name > right.service_name ? 1 : 0))
    .map((entry) => ({
      service_name: entry.service_name,
      container_count: entry.liveContainers,
      node_count: entry.liveNodes.size,
      cpu_pct_total: entry.cpuTotal,
      mem_used_total: entry.memTotal,
      cpu_pct_total_agg: aggregates.get(entry.service_name)?.cpu ?? null,
      mem_used_agg: aggregates.get(entry.service_name)?.mem ?? null,
      total_quota_cores: entry.quotaTotal,
      total_mem_limit_bytes: entry.memLimitTotal,
      last_seen: entry.lastSeen,
    }))
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
    cpu_pct_total_agg: toFiniteOrNull(row.cpu_pct_total_agg),
    mem_used_agg: toFiniteOrNull(row.mem_used_agg),
    total_quota_cores: row.total_quota_cores == null ? null : Number(row.total_quota_cores),
    total_mem_limit_bytes: memLimit,
    mem_pct: memUsed != null && memLimit ? (memUsed / memLimit) * 100 : null,
    last_seen: row.last_seen,
  }
}

export async function getOverview(aggWindow?: ServiceAggWindow) {
  const [nodes, services] = await Promise.all([
    listNodesQuery(),
    listServicesQuery(undefined, aggWindow),
  ])
  return {
    nodes: nodes.map(serializeNodeOverview),
    services: services.map(serializeServiceOverview),
  }
}

export async function listNodes() {
  const rows = await listNodesQuery()
  return rows.map(serializeNodeOverview)
}

export async function listServices(aggWindow?: ServiceAggWindow) {
  const rows = await listServicesQuery(undefined, aggWindow)
  return rows.map(serializeServiceOverview)
}

export async function listServicesOnNode(nodeKey: string, aggWindow?: ServiceAggWindow) {
  const rows = await listServicesQuery(nodeKey, aggWindow)
  return rows.map(serializeServiceOverview)
}

interface ContainerListRow {
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

interface ContainerDimensionRow extends RowDataPacket {
  id: number
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
}

export async function listServiceContainers(serviceName: string) {
  // Only live replicas are listed: dead Swarm task generations used to inflate
  // the replica table (48 rows for 2 running replicas). Their samples are still
  // in ClickHouse and still reachable via /api/metrics/containers/:key/timeseries.
  const [dimensions] = await pool.query<ContainerDimensionRow[]>(
    `
      SELECT
        c.id,
        c.container_key,
        c.name,
        c.image,
        c.task_name,
        c.replica_slot,
        n.node_key,
        n.hostname,
        c.cpu_quota_cores,
        c.mem_limit_bytes,
        c.last_seen
      FROM metric_services sv
      JOIN metric_containers c ON c.service_id = sv.id
      LEFT JOIN metric_nodes n ON n.id = c.node_id
      WHERE sv.service_name = ?
        AND c.last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
      ORDER BY c.replica_slot ASC, c.name ASC
    `,
    [serviceName, LIVE_WINDOW_MINUTES],
  )
  if (!dimensions.length) return []

  const latest = await latestContainerStats()

  return dimensions.map((row) => {
    const sample = latest.get(row.id)
    return serializeContainerRow({
      container_key: row.container_key,
      name: row.name,
      image: row.image,
      task_name: row.task_name,
      replica_slot: row.replica_slot,
      node_key: row.node_key,
      hostname: row.hostname,
      cpu_quota_cores: row.cpu_quota_cores,
      mem_limit_bytes: row.mem_limit_bytes,
      last_seen: row.last_seen,
      cpu_pct: sample ? chNumber(sample.cpu_pct) : null,
      cpu_pct_max: sample ? chNumber(sample.cpu_pct_max) : null,
      mem_used_bytes: sample ? chNumber(sample.mem_used_bytes) : null,
    })
  })
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

// Shape of every bucketed timeseries row coming back from ClickHouse. UInt64
// columns arrive as strings, so everything is parsed with chNumber().
type ChTimeseriesRow = {
  bucket_start: string
  value: number | string | null
  reference?: number | string | null
  net_rx_last?: number | string | null
  net_tx_last?: number | string | null
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

  const nodeSubject = {
    node_key: node.node_key,
    hostname: node.hostname,
    cpu_cores: node.cpu_cores,
    mem_total_bytes: node.mem_total_bytes == null ? null : Number(node.mem_total_bytes),
  }

  // One aggregate per bucket straight over the raw samples: avg/sum/count/max
  // in ClickHouse and true quantile(0.95|0.99) percentiles (no JS nearest-rank
  // approximation over minute rollups any more).
  const column = metric === 'memory' ? 'mem_used' : 'cpu_pct'
  const rows = await chSelect<ChTimeseriesRow>(
    `
      SELECT
        ${bucketStartExpr(granularity)} AS bucket_start,
        ${aggExprOver(agg, { value: column })} AS value,
        max(mem_total) AS reference
      FROM ${NODE_SAMPLES_TABLE}
      WHERE node_id = {entity_id:UInt32}
        AND ts >= toDateTime({from:UInt32})
        AND ts < toDateTime({to:UInt32})
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    {
      entity_id: node.id,
      from: toEpochSeconds(window.from),
      to: toEpochSeconds(window.to),
    },
  )

  const points = rows.map((row) =>
    buildScalarPoint(
      row.bucket_start,
      metric,
      agg,
      chNumber(row.value),
      metric === 'memory' ? chNumber(row.reference) : null,
    ),
  )

  return { node: nodeSubject, points }
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

  // Only the live containers are needed now: history comes from the samples'
  // own service_id, while the live replicas define the quota/limit reference
  // lines (dead task generations used to multiply them).
  const [containerRows] = await pool.query<
    ({ cpu_quota_cores: number | null; mem_limit_bytes: number | null; is_live: number } & RowDataPacket)[]
  >(
    `
      SELECT
        cpu_quota_cores,
        mem_limit_bytes,
        (last_seen >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)) AS is_live
      FROM metric_containers
      WHERE service_id = ?
    `,
    [LIVE_WINDOW_MINUTES, serviceId],
  )

  const liveRows = containerRows.filter((row) => Number(row.is_live) === 1)

  let totalQuota: number | null = null
  for (const row of liveRows) {
    if (row.cpu_quota_cores == null) continue
    totalQuota = (totalQuota ?? 0) + Number(row.cpu_quota_cores)
  }

  // A service memory % is only meaningful when every live replica reports a limit.
  let totalMemLimit: number | null = null
  if (liveRows.length && liveRows.every((row) => row.mem_limit_bytes != null)) {
    totalMemLimit = liveRows.reduce((sum, row) => sum + Number(row.mem_limit_bytes), 0)
  }

  const serviceSubject = {
    service_name: serviceName,
    total_quota_cores: totalQuota,
    total_mem_limit_bytes: totalMemLimit,
  }

  // No container-list guard: the samples carry service_id themselves, so history
  // is returned even when the MySQL dimension rows have already been pruned.
  //
  // Two levels of aggregation, matching the previous MySQL shape exactly:
  //   inner  – per container, per minute (avg / max / sample count)
  //   middle – per minute totals across replicas
  //   outer  – re-bucket to the requested granularity
  const column = metric === 'memory' ? 'mem_used' : 'cpu_pct'
  const rows = await chSelect<ChTimeseriesRow>(
    `
      SELECT
        ${bucketStartExpr(granularity, 'minute')} AS bucket_start,
        ${aggExprOver(agg, { value: 'avg_total', max: 'max_total', count: 'sample_count' })} AS value
      FROM (
        SELECT
          minute,
          sum(container_avg) AS avg_total,
          sum(container_max) AS max_total,
          sum(container_samples) AS sample_count
        FROM (
          SELECT
            container_id,
            toStartOfMinute(ts, 'UTC') AS minute,
            avg(${column}) AS container_avg,
            max(${column}) AS container_max,
            count() AS container_samples
          FROM ${CONTAINER_SAMPLES_TABLE}
          WHERE service_id = {service_id:UInt32}
            AND ts >= toDateTime({from:UInt32})
            AND ts < toDateTime({to:UInt32})
          GROUP BY container_id, minute
        )
        GROUP BY minute
      )
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    {
      service_id: serviceId,
      from: toEpochSeconds(window.from),
      to: toEpochSeconds(window.to),
    },
  )

  const points = rows.map((row) =>
    buildScalarPoint(row.bucket_start, metric, agg, chNumber(row.value), totalMemLimit),
  )

  return { service: serviceSubject, points }
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

  // net_*_last are the newest counter readings inside each bucket; the rates
  // are derived from bucket-to-bucket deltas below, exactly as before.
  const column = metric === 'memory' ? 'mem_used' : 'cpu_pct'
  const rows = await chSelect<ChTimeseriesRow>(
    `
      SELECT
        ${bucketStartExpr(granularity)} AS bucket_start,
        ${aggExprOver(agg, { value: column })} AS value,
        max(mem_limit) AS reference,
        argMax(net_rx, ts) AS net_rx_last,
        argMax(net_tx, ts) AS net_tx_last
      FROM ${CONTAINER_SAMPLES_TABLE}
      WHERE container_id = {entity_id:UInt32}
        AND ts >= toDateTime({from:UInt32})
        AND ts < toDateTime({to:UInt32})
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `,
    {
      entity_id: container.id,
      from: toEpochSeconds(window.from),
      to: toEpochSeconds(window.to),
    },
  )

  let prevRx: number | null = null
  let prevTx: number | null = null
  let prevTime: number | null = null

  const points: TimeseriesPoint[] = rows.map((row) => {
    const bucketTime = new Date(`${row.bucket_start.replace(' ', 'T')}Z`).getTime()
    const deltaSeconds = prevTime == null ? null : (bucketTime - prevTime) / 1000

    const rx = chNumber(row.net_rx_last)
    const tx = chNumber(row.net_tx_last)

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

    const point = buildScalarPoint(
      row.bucket_start,
      metric,
      agg,
      chNumber(row.value),
      metric === 'memory' ? chNumber(row.reference) : null,
    )
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
// or null entries where the metric can't be computed for that minute. Values
// are per-minute averages over the ClickHouse raw samples, which is what the
// MySQL minute rollups stored.
const entityWindowValues = async (
  rule: MetricAlertRuleRow,
  entity: ResolvedEntity,
): Promise<Array<number | null>> => {
  const limit = rule.sustained_minutes
  // Anything older than the sustained window plus the staleness allowance can
  // never satisfy isWindowFresh(), so bound the scan.
  const from = toEpochSeconds(
    new Date(Date.now() - (limit + ALERT_STALE_MINUTES + 2) * 60 * 1000),
  )

  if (rule.scope === 'node') {
    const rows = await chSelect<{
      bucket_start: string
      cpu_avg: number | string | null
      mem_avg: number | string | null
      mem_total_last: number | string | null
    }>(
      `
        SELECT
          ${MINUTE_START_EXPR} AS bucket_start,
          avg(cpu_pct) AS cpu_avg,
          avg(mem_used) AS mem_avg,
          max(mem_total) AS mem_total_last
        FROM ${NODE_SAMPLES_TABLE}
        WHERE node_id = {entity_id:UInt32}
          AND ts >= toDateTime({from:UInt32})
        GROUP BY bucket_start
        ORDER BY bucket_start DESC
        LIMIT {limit:UInt32}
      `,
      { entity_id: entity.entityId, from, limit },
    )
    if (!isWindowFresh(rows[0]?.bucket_start)) return []
    return rows.map((row) => {
      if (rule.metric === 'memory') {
        const total = chNumber(row.mem_total_last)
        const used = chNumber(row.mem_avg)
        return total && used != null ? (used / total) * 100 : null
      }
      return chNumber(row.cpu_avg)
    })
  }

  if (rule.scope === 'container') {
    const rows = await chSelect<{
      bucket_start: string
      cpu_avg: number | string | null
      mem_avg: number | string | null
      cpu_quota_cores_last: number | string | null
      mem_limit_bytes_last: number | string | null
    }>(
      `
        SELECT
          ${MINUTE_START_EXPR} AS bucket_start,
          avg(cpu_pct) AS cpu_avg,
          avg(mem_used) AS mem_avg,
          argMax(cpu_quota_cores, ts) AS cpu_quota_cores_last,
          argMax(mem_limit, ts) AS mem_limit_bytes_last
        FROM ${CONTAINER_SAMPLES_TABLE}
        WHERE container_id = {entity_id:UInt32}
          AND ts >= toDateTime({from:UInt32})
        GROUP BY bucket_start
        ORDER BY bucket_start DESC
        LIMIT {limit:UInt32}
      `,
      { entity_id: entity.entityId, from, limit },
    )
    if (!isWindowFresh(rows[0]?.bucket_start)) return []
    return rows.map((row) => {
      const cpuPct = chNumber(row.cpu_avg)
      if (rule.metric === 'memory') {
        const limitBytes = chNumber(row.mem_limit_bytes_last)
        const used = chNumber(row.mem_avg)
        return limitBytes && used != null ? (used / limitBytes) * 100 : null
      }
      // Prefer % of allotted quota when a quota is set, else raw cpu_pct.
      const quota = chNumber(row.cpu_quota_cores_last)
      return quota && cpuPct != null ? cpuPct / quota : cpuPct
    })
  }

  // service scope: aggregate across replicas per minute. Filtering on the
  // samples' own service_id removes what used to be a MySQL round-trip for the
  // replica list.
  const rows = await chSelect<{
    bucket_start: string
    cpu_avg: number | string | null
    mem_used_total: number | string | null
    mem_limit_total: number | string | null
    null_limits: number | string
  }>(
    `
      SELECT
        formatDateTime(minute, '%Y-%m-%d %H:%i:%S', 'UTC') AS bucket_start,
        sum(cpu_sum) / sum(cpu_samples) AS cpu_avg,
        sum(mem_avg) AS mem_used_total,
        sum(mem_limit_last) AS mem_limit_total,
        countIf(isNull(mem_limit_last)) AS null_limits
      FROM (
        SELECT
          container_id,
          toStartOfMinute(ts, 'UTC') AS minute,
          sum(cpu_pct) AS cpu_sum,
          count() AS cpu_samples,
          avg(mem_used) AS mem_avg,
          argMax(mem_limit, ts) AS mem_limit_last
        FROM ${CONTAINER_SAMPLES_TABLE}
        WHERE service_id = {entity_id:UInt32}
          AND ts >= toDateTime({from:UInt32})
        GROUP BY container_id, minute
      )
      GROUP BY minute
      ORDER BY minute DESC
      LIMIT {limit:UInt32}
    `,
    { entity_id: entity.entityId, from, limit },
  )
  if (!isWindowFresh(rows[0]?.bucket_start)) return []
  return rows.map((row) => {
    if (rule.metric === 'memory') {
      // Only a valid % when every replica reports a limit.
      if (Number(row.null_limits) > 0) return null
      const limitTotal = chNumber(row.mem_limit_total)
      const used = chNumber(row.mem_used_total)
      return limitTotal && used != null ? (used / limitTotal) * 100 : null
    }
    return chNumber(row.cpu_avg)
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
  // Sample values come from ClickHouse; without it every rule would just log a
  // failure, so skip the sweep entirely until the store is back.
  if (!isClickhouseReady()) return

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
// One-time sample dimension backfill
// ---------------------------------------------------------------------------

// Containers per mutation. Keeps each statement well inside ClickHouse's
// max_query_size (256 KB by default) — ~2000 ids render to roughly 30 KB across
// the three inlined lists.
const DIMENSION_BACKFILL_CHUNK = 2000

let sampleDimensionBackfillDone = false

interface ContainerDimensionIdRow extends RowDataPacket {
  id: number
  service_id: number | null
  node_id: number | null
}

// Stamps service_id / node_id onto samples ingested before those columns
// existed. Without it, every service-scoped query (which now filters on
// service_id) would silently omit all pre-upgrade history until the TTL aged it
// out. Runs at most once per boot, and only while rows still need fixing, so it
// becomes a single cheap probe once the fleet has been upgraded.
//
// The WHERE clause is restricted to the containers this chunk can actually
// resolve, so containers that genuinely have no service (service_id stays 0) do
// not keep the mutation alive on later boots.
const backfillSampleDimensions = async (): Promise<void> => {
  if (sampleDimensionBackfillDone) return
  if (!isClickhouseReady()) return
  // Attempt once per boot regardless of outcome: a failing mutation must not be
  // reissued on every tick.
  sampleDimensionBackfillDone = true

  const probe = await chSelect<{ total: string | number }>(
    `SELECT count() AS total FROM ${CONTAINER_SAMPLES_TABLE} WHERE service_id = 0 OR node_id = 0`,
  )
  const pending = Number(probe[0]?.total ?? 0)
  if (!pending) return

  const [rows] = await pool.query<ContainerDimensionIdRow[]>(
    'SELECT id, service_id, node_id FROM metric_containers WHERE service_id IS NOT NULL OR node_id IS NOT NULL',
  )
  if (!rows.length) return

  console.log(
    `[metrics] backfilling service_id/node_id on ${pending} container samples (${rows.length} containers)`,
  )

  for (let offset = 0; offset < rows.length; offset += DIMENSION_BACKFILL_CHUNK) {
    const chunk = rows.slice(offset, offset + DIMENSION_BACKFILL_CHUNK)
    const idsSql = toIntListSql(chunk.map((row) => row.id))
    const serviceIdsSql = toIntListSql(chunk.map((row) => row.service_id ?? 0))
    const nodeIdsSql = toIntListSql(chunk.map((row) => row.node_id ?? 0))
    chCommandDetached(
      `ALTER TABLE ${CONTAINER_SAMPLES_TABLE}
         UPDATE
           service_id = transform(container_id, [${idsSql}], [${serviceIdsSql}], 0),
           node_id = transform(container_id, [${idsSql}], [${nodeIdsSql}], 0)
         WHERE (service_id = 0 OR node_id = 0)
           AND container_id IN (${idsSql})`,
    )
  }

  // Index the pre-existing parts; ADD INDEX alone only covers new ones.
  chCommandDetached(`ALTER TABLE ${CONTAINER_SAMPLES_TABLE} MATERIALIZE INDEX idx_service`)
  chCommandDetached(`ALTER TABLE ${CONTAINER_SAMPLES_TABLE} MATERIALIZE INDEX idx_node`)
}

// ---------------------------------------------------------------------------
// Retention + dimension pruning
// ---------------------------------------------------------------------------

// Sample retention is handled by the ClickHouse TTL (METRIC_RETENTION_DAYS),
// so this sweep only prunes MySQL dimension rows. Pruned dimensions get their
// ClickHouse rows removed with a fire-and-forget lightweight mutation, so no
// orphaned samples linger for the rest of the TTL.
const runRetention = async (): Promise<void> => {
  const pruneDays = config.metrics.dimensionPruneDays

  const [staleContainers] = await pool.query<({ id: number } & RowDataPacket)[]>(
    'SELECT id FROM metric_containers WHERE last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
    [pruneDays],
  )
  await pool.query(
    'DELETE FROM metric_containers WHERE last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)',
    [pruneDays],
  )
  if (staleContainers.length) {
    chCommandDetached(
      `ALTER TABLE ${CONTAINER_SAMPLES_TABLE} DELETE WHERE container_id IN (${toIntListSql(
        staleContainers.map((row) => row.id),
      )})`,
    )
  }

  await pool.query(
    `
      DELETE FROM metric_services
      WHERE id NOT IN (SELECT service_id FROM metric_containers WHERE service_id IS NOT NULL)
    `,
  )

  const [staleNodes] = await pool.query<({ id: number } & RowDataPacket)[]>(
    `
      SELECT id FROM metric_nodes
      WHERE id NOT IN (SELECT node_id FROM metric_containers WHERE node_id IS NOT NULL)
        AND last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
    `,
    [pruneDays],
  )
  if (staleNodes.length) {
    chCommandDetached(
      `ALTER TABLE ${NODE_SAMPLES_TABLE} DELETE WHERE node_id IN (${staleNodes
        .map((row) => Number(row.id))
        .join(', ')})`,
    )
  }
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
    // Deferred to the ticker rather than startup so it retries on a later tick
    // if ClickHouse was still unreachable when the process booted.
    await backfillSampleDimensions()

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
