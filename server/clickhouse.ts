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

const containerSamplesDdl = (retentionDays: number): string => `
  CREATE TABLE IF NOT EXISTS ${CONTAINER_SAMPLES_TABLE} (
    container_id UInt32,
    ts DateTime,
    cpu_pct Float32,
    mem_used UInt64,
    mem_limit Nullable(UInt64),
    cpu_quota_cores Nullable(Float32),
    net_rx UInt64,
    net_tx UInt64
  )
  ENGINE = MergeTree
  ORDER BY (container_id, ts)
  TTL ts + INTERVAL ${retentionDays} DAY
`

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
