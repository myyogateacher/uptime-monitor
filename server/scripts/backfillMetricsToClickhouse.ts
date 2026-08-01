/**
 * Copies the legacy MySQL minute-rollup metric samples into the ClickHouse raw
 * sample tables.
 *
 *   bun server/scripts/backfillMetricsToClickhouse.ts [--truncate] [--batch=50000]
 *
 * One synthetic raw row is written per minute bucket:
 *   ts       = bucket_start
 *   cpu_pct  = cpu_pct_sum / sample_count   (the bucket average)
 *   mem_used = mem_used_sum / sample_count  (the bucket average)
 * The per-minute maxima are not representable as a single raw sample and are
 * therefore lost; historical `max`/`p95`/`p99` queries over backfilled ranges
 * degrade to the per-minute averages. Everything ingested after the migration
 * carries full raw resolution.
 *
 * Safety: refuses to run when the target table already holds rows unless
 * --truncate is passed (which empties the table first).
 */
import type { RowDataPacket } from 'mysql2/promise'

import {
  CONTAINER_SAMPLES_TABLE,
  NODE_SAMPLES_TABLE,
  chInsert,
  chSelect,
  ensureClickhouseSchema,
  getClickhouse,
  toEpochSeconds,
  toNullableFloat,
  toNullableUInt,
  toUInt,
} from '../clickhouse'
import { pool } from '../db'

const args = process.argv.slice(2)
const truncate = args.includes('--truncate')
const batchArg = args.find((arg) => arg.startsWith('--batch='))
const BATCH_SIZE = Math.max(1000, Number(batchArg?.split('=')[1] ?? 50_000) || 50_000)

const log = (message: string): void => {
  console.log(`[backfill] ${message}`)
}

const bucketToDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)

const tableRowCount = async (table: string): Promise<number> => {
  const rows = await chSelect<{ total: string | number }>(
    `SELECT count() AS total FROM ${table}`,
  )
  return Number(rows[0]?.total ?? 0)
}

const prepareTable = async (table: string): Promise<boolean> => {
  const existing = await tableRowCount(table)
  if (!existing) return true
  if (!truncate) {
    log(
      `${table} already holds ${existing} rows; skipping. Re-run with --truncate to replace them.`,
    )
    return false
  }
  log(`--truncate: emptying ${table} (${existing} rows)`)
  await getClickhouse().command({ query: `TRUNCATE TABLE ${table}` })
  return true
}

interface NodeRollupRow extends RowDataPacket {
  entity_id: number
  bucket_start: Date | string
  sample_count: number
  cpu_pct_sum: number
  mem_used_sum: number
  mem_total_last: number | null
}

interface ContainerRollupRow extends RowDataPacket {
  entity_id: number
  bucket_start: Date | string
  sample_count: number
  cpu_pct_sum: number
  mem_used_sum: number
  cpu_quota_cores_last: number | null
  mem_limit_bytes_last: number | null
  net_rx_last: number | null
  net_tx_last: number | null
}

const backfillNodes = async (): Promise<void> => {
  if (!(await prepareTable(NODE_SAMPLES_TABLE))) return

  const [countRows] = await pool.query<({ total: number } & RowDataPacket)[]>(
    'SELECT COUNT(*) AS total FROM metric_node_samples',
  )
  const total = Number(countRows[0]?.total ?? 0)
  log(`node rollups to copy: ${total}`)

  let offset = 0
  let copied = 0
  for (;;) {
    const [rows] = await pool.query<NodeRollupRow[]>(
      `
        SELECT entity_id, bucket_start, sample_count, cpu_pct_sum, mem_used_sum, mem_total_last
        FROM metric_node_samples
        ORDER BY entity_id ASC, bucket_start ASC
        LIMIT ? OFFSET ?
      `,
      [BATCH_SIZE, offset],
    )
    if (!rows.length) break

    const values = rows.map((row) => {
      const count = Number(row.sample_count) || 1
      return {
        node_id: Number(row.entity_id),
        ts: toEpochSeconds(bucketToDate(row.bucket_start)),
        cpu_pct: Number(row.cpu_pct_sum) / count,
        mem_used: toUInt(Number(row.mem_used_sum) / count),
        mem_total: toUInt(row.mem_total_last ?? 0),
      }
    })
    await chInsert(NODE_SAMPLES_TABLE, values)

    copied += rows.length
    offset += rows.length
    log(`nodes: ${copied}/${total}`)
    if (rows.length < BATCH_SIZE) break
  }
  log(`nodes done (${copied} rows)`)
}

const backfillContainers = async (): Promise<void> => {
  if (!(await prepareTable(CONTAINER_SAMPLES_TABLE))) return

  const [countRows] = await pool.query<({ total: number } & RowDataPacket)[]>(
    'SELECT COUNT(*) AS total FROM metric_container_samples',
  )
  const total = Number(countRows[0]?.total ?? 0)
  log(`container rollups to copy: ${total}`)

  let offset = 0
  let copied = 0
  for (;;) {
    const [rows] = await pool.query<ContainerRollupRow[]>(
      `
        SELECT
          entity_id, bucket_start, sample_count, cpu_pct_sum, mem_used_sum,
          cpu_quota_cores_last, mem_limit_bytes_last, net_rx_last, net_tx_last
        FROM metric_container_samples
        ORDER BY entity_id ASC, bucket_start ASC
        LIMIT ? OFFSET ?
      `,
      [BATCH_SIZE, offset],
    )
    if (!rows.length) break

    const values = rows.map((row) => {
      const count = Number(row.sample_count) || 1
      return {
        container_id: Number(row.entity_id),
        ts: toEpochSeconds(bucketToDate(row.bucket_start)),
        cpu_pct: Number(row.cpu_pct_sum) / count,
        mem_used: toUInt(Number(row.mem_used_sum) / count),
        mem_limit: toNullableUInt(row.mem_limit_bytes_last),
        cpu_quota_cores: toNullableFloat(row.cpu_quota_cores_last),
        net_rx: toUInt(row.net_rx_last ?? 0),
        net_tx: toUInt(row.net_tx_last ?? 0),
      }
    })
    await chInsert(CONTAINER_SAMPLES_TABLE, values)

    copied += rows.length
    offset += rows.length
    log(`containers: ${copied}/${total}`)
    if (rows.length < BATCH_SIZE) break
  }
  log(`containers done (${copied} rows)`)
}

const main = async (): Promise<void> => {
  const ready = await ensureClickhouseSchema()
  if (!ready) {
    throw new Error('ClickHouse is unreachable; check CLICKHOUSE_URL and retry')
  }

  await backfillNodes()
  await backfillContainers()
  log('backfill complete')
}

main()
  .then(async () => {
    await getClickhouse().close()
    await pool.end()
    process.exit(0)
  })
  .catch(async (error: unknown) => {
    console.error('[backfill] failed:', error)
    await getClickhouse()
      .close()
      .catch(() => undefined)
    await pool.end().catch(() => undefined)
    process.exit(1)
  })
