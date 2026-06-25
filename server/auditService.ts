import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { pool } from "./db";

export type AuditActor = {
  email?: string | null;
  name?: string | null;
};

export type AuditEntryInput = {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  entityLabel?: string | null;
  summary: string;
};

export interface AuditLogRow extends RowDataPacket {
  id: number;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  summary: string;
  created_at: Date | string;
}

/**
 * Persists an audit entry. Audit logging must never break the request that
 * triggered it, so any failure here is logged and swallowed.
 */
export const recordAudit = async (
  actor: AuditActor,
  entry: AuditEntryInput,
): Promise<void> => {
  try {
    await pool.query<ResultSetHeader>(
      `
        INSERT INTO audit_logs
          (actor_email, actor_name, action, entity_type, entity_id, entity_label, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        actor.email ?? null,
        actor.name ?? null,
        entry.action,
        entry.entityType,
        entry.entityId == null ? null : String(entry.entityId),
        entry.entityLabel ?? null,
        entry.summary,
      ],
    );
  } catch (error) {
    console.error("[audit] Failed to record audit entry:", error);
  }
};

export const AUDIT_RETENTION_PERIODS = {
  "3m": { days: 90, label: "last 3 months" },
  "1m": { days: 30, label: "last 1 month" },
  "1w": { days: 7, label: "last 1 week" },
  "1d": { days: 1, label: "last 1 day" },
  all: { days: null, label: "all entries" },
} as const;

export type AuditRetentionPeriod = keyof typeof AUDIT_RETENTION_PERIODS;

export const isAuditRetentionPeriod = (
  value: string,
): value is AuditRetentionPeriod =>
  Object.prototype.hasOwnProperty.call(AUDIT_RETENTION_PERIODS, value);

/**
 * Deletes audit entries. For a dated period, removes everything older than the
 * retention window; for "all", clears the table. Returns the number removed.
 */
export const truncateAuditLogs = async (
  period: AuditRetentionPeriod,
): Promise<number> => {
  const { days } = AUDIT_RETENTION_PERIODS[period];
  if (days == null) {
    const [result] = await pool.query<ResultSetHeader>(
      "DELETE FROM audit_logs",
    );
    return result.affectedRows ?? 0;
  }
  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
    [days],
  );
  return result.affectedRows ?? 0;
};

export const listAuditLogs = async (limit = 200): Promise<AuditLogRow[]> => {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const [rows] = await pool.query<AuditLogRow[]>(
    "SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?",
    [safeLimit],
  );
  return rows;
};
