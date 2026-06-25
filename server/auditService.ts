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

export const listAuditLogs = async (limit = 200): Promise<AuditLogRow[]> => {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const [rows] = await pool.query<AuditLogRow[]>(
    "SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?",
    [safeLimit],
  );
  return rows;
};
