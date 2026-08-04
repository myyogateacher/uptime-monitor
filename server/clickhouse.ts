import { createClient, type ClickHouseClient } from '@clickhouse/client'

import { config } from './config'

// ---------------------------------------------------------------------------
// ClickHouse holds the RAW metric samples (one row per collector tick, ~15s).
// MySQL keeps the dimension tables (metric_nodes / metric_services /
// metric_containers) and the alert rules/state, so numeric dimension ids are
// still minted by MySQL and used verbatim as the ClickHouse sort keys.
//
// Timestamps are always exchanged as Unix epoch seconds so nothing depends on
// the ClickHouse server's local timezone: inserts send integers, reads bucket
// and format with an explicit 'UTC' argument.
// ---------------------------------------------------------------------------

export const NODE_SAMPLES_TABLE = 'metric_node_samples_raw'
export const CONTAINER_SAMPLES_TABLE = 'metric_container_samples_raw'

/** Thrown when ClickHouse has not been reachable since boot (routes → 503). */
export class ClickhouseUnavailableError extends Error {
  constructor(message = 'ClickHouse is unavailable; metrics storage is offline') {
    super(message)
    this.name = 'ClickhouseUnavailableError'
  }
}

/** Thrown when a ClickHouse statement fails (routes → 500, sidecar retries). */
export class ClickhouseQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ClickhouseQueryError'
  }
}

const SCHEMA_RETRY_MS = 30_000

let client: ClickHouseClient | null = null
let ready = false
let lastError: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

const createConfiguredClient = (database?: string): ClickHouseClient =>
  createClient({
    url: config.clickhouse.url,
    username: config.clickhouse.username,
    password: config.clickhouse.password,
    ...(database ? { database } : {}),
  })

export function getClickhouse(): ClickHouseClient {
  if (!client) client = createConfiguredClient(config.clickhouse.database)
  return client
}

export function isClickhouseReady(): boolean {
  return ready
}

export function clickhouseStatus(): { ready: boolean; error: string | null } {
  return { ready, error: lastError }
}

/** Throws ClickhouseUnavailableError unless the schema bootstrap succeeded. */
export function assertClickhouseReady(): void {
  if (!ready) {
    throw new ClickhouseUnavailableError(
      lastError
        ? `ClickHouse is unavailable: ${lastError}`
        : 'ClickHouse is unavailable; metrics storage is offline',
    )
  }
}

const nodeSamplesDdl = (retentionDays: number): string => `
  CREATE TABLE IF NOT EXISTS ${NODE_SAMPLES_TABLE} (
    node_id UInt32,
    ts DateTime,
    cpu_pct Float32,
    mem_used UInt64,
    mem_total UInt64
  )
  ENGINE = MergeTree
  ORDER BY (node_id, ts)
  TTL ts + INTERVAL ${retentionDays} DAY
`

// service_id / node_id are denormalized onto every sample so service-scoped and
// node-scoped queries can filter by dimension directly. The alternative —
// resolving container ids in MySQL and shipping the list to ClickHouse — grows
// without bound, because every deployment mints a new task generation (and so a
// new container row) per service. 0 means "unknown", which is what pre-upgrade
// rows and containers with no service carry.
const containerSamplesDdl = (retentionDays: number): string => `
  CREATE TABLE IF NOT EXISTS ${CONTAINER_SAMPLES_TABLE} (
    container_id UInt32,
    service_id UInt32 DEFAULT 0,
    node_id UInt32 DEFAULT 0,
    ts DateTime,
    cpu_pct Float32,
    mem_used UInt64,
    mem_limit Nullable(UInt64),
    cpu_quota_cores Nullable(Float32),
    net_rx UInt64,
    net_tx UInt64,
    INDEX idx_service service_id TYPE set(0) GRANULARITY 4,
    INDEX idx_node node_id TYPE set(0) GRANULARITY 4
  )
  ENGINE = MergeTree
  ORDER BY (container_id, ts)
  TTL ts + INTERVAL ${retentionDays} DAY
`

// In-place upgrade for tables created before service_id / node_id existed.
// ORDER BY deliberately stays (container_id, ts) — changing the sort key would
// require recreating the table. Rows are physically clustered by container, and
// a container belongs to exactly one service and node, so the set(0) skipping
// indexes prune granules very effectively despite service_id / node_id not
// being in the sort key.
//
// ADD INDEX only covers parts written afterwards; existing parts are indexed by
// the MATERIALIZE INDEX mutations that backfillSampleDimensions() issues once,
// together with the service_id/node_id value backfill. Every statement here is
// idempotent and cheap (metadata-only), so it is safe to run on every boot.
const containerSamplesMigrations = (): string[] => [
  `ALTER TABLE ${CONTAINER_SAMPLES_TABLE} ADD COLUMN IF NOT EXISTS service_id UInt32 DEFAULT 0`,
  `ALTER TABLE ${CONTAINER_SAMPLES_TABLE} ADD COLUMN IF NOT EXISTS node_id UInt32 DEFAULT 0`,
  `ALTER TABLE ${CONTAINER_SAMPLES_TABLE} ADD INDEX IF NOT EXISTS idx_service service_id TYPE set(0) GRANULARITY 4`,
  `ALTER TABLE ${CONTAINER_SAMPLES_TABLE} ADD INDEX IF NOT EXISTS idx_node node_id TYPE set(0) GRANULARITY 4`,
]

/**
 * Creates the database and both sample tables if they do not exist. Never
 * throws: on failure it logs, marks ClickHouse unavailable (metrics endpoints
 * answer 503) and retries in the background so the uptime monitor itself keeps
 * running when the analytics store is down.
 */
export async function ensureClickhouseSchema(): Promise<boolean> {
  const retentionDays = Math.max(1, Math.floor(config.metrics.retentionDays))

  try {
    const bootstrap = createConfiguredClient()
    try {
      await bootstrap.command({
        query: `CREATE DATABASE IF NOT EXISTS ${config.clickhouse.database}`,
      })
    } finally {
      await bootstrap.close()
    }

    const ch = getClickhouse()
    await ch.command({ query: nodeSamplesDdl(retentionDays) })
    await ch.command({ query: containerSamplesDdl(retentionDays) })
    for (const migration of containerSamplesMigrations()) {
      await ch.command({ query: migration })
    }

    ready = true
    lastError = null
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    console.log(
      `[clickhouse] schema ready at ${config.clickhouse.url}/${config.clickhouse.database} (TTL ${retentionDays}d)`,
    )
    return true
  } catch (error) {
    ready = false
    lastError = error instanceof Error ? error.message : String(error)
    console.error(
      `[clickhouse] unreachable at ${config.clickhouse.url} (${lastError}). ` +
        'Metrics ingest and metrics APIs will answer 503 until it recovers; ' +
        'the rest of the uptime monitor keeps running.',
    )
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        void ensureClickhouseSchema()
      }, SCHEMA_RETRY_MS)
      retryTimer.unref?.()
    }
    return false
  }
}

export function stopClickhouseRetry(): void {
  if (!retryTimer) return
  clearTimeout(retryTimer)
  retryTimer = null
}

export type QueryParams = Record<string, unknown>

/** Runs a SELECT and returns rows as plain objects. */
export async function chSelect<T>(query: string, params: QueryParams = {}): Promise<T[]> {
  assertClickhouseReady()
  try {
    const resultSet = await getClickhouse().query({
      query,
      query_params: params,
      format: 'JSONEachRow',
    })
    return await resultSet.json<T>()
  } catch (error) {
    ready = false
    lastError = error instanceof Error ? error.message : String(error)
    scheduleRecheck()
    throw new ClickhouseQueryError(`ClickHouse query failed: ${lastError}`, { cause: error })
  }
}

/** Batched JSONEachRow insert. Throws so callers can surface a 5xx. */
export async function chInsert(table: string, values: Record<string, unknown>[]): Promise<void> {
  if (!values.length) return
  assertClickhouseReady()
  try {
    await getClickhouse().insert({ table, values, format: 'JSONEachRow' })
  } catch (error) {
    ready = false
    lastError = error instanceof Error ? error.message : String(error)
    scheduleRecheck()
    throw new ClickhouseQueryError(`ClickHouse insert failed: ${lastError}`, { cause: error })
  }
}

/** Fire-and-forget DDL/mutation (lightweight deletes on dimension pruning). */
export function chCommandDetached(query: string): void {
  if (!ready) return
  void getClickhouse()
    .command({ query })
    .catch((error: unknown) => {
      console.error(
        `[clickhouse] mutation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
}

const scheduleRecheck = (): void => {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void ensureClickhouseSchema()
  }, SCHEMA_RETRY_MS)
  retryTimer.unref?.()
}

/** Epoch seconds for a JS Date; the wire format for every ts we send. */
export const toEpochSeconds = (value: Date): number => Math.floor(value.getTime() / 1000)

/** ClickHouse rejects fractional values for UInt64 columns. */
export const toUInt = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed)
}

export const toNullableUInt = (value: unknown): number | null => {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed)
}

export const toNullableFloat = (value: unknown): number | null => {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
