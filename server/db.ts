import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { config } from "./config";

const basePool: Pool = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
});

// A pooled socket the server has already closed (wait_timeout, a MySQL
// restart, a network blip) still looks usable to the pool and only fails when
// a query is finally written to it. mysql2 reports that failure in one of the
// shapes below; none of them mean the statement itself was bad, so the query
// can be replayed on a connection that is known to be alive.
const DEAD_CONNECTION_ERROR_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_ENQUEUE_AFTER_QUIT",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "PROTOCOL_PACKETS_OUT_OF_ORDER",
  "PROTOCOL_UNEXPECTED_PACKET",
  // MySQL 8.0.24+ answers a query on a timed-out session with this error
  // packet, which mysql2 also logs as "got packets out of order".
  "ER_CLIENT_INTERACTION_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

const DEAD_CONNECTION_MESSAGES = [
  "packets out of order",
  "because of inactivity",
  "connection lost",
  "closed state",
  "server has gone away",
];

const describeError = (error: unknown): string =>
  error instanceof Error ? `${(error as { code?: string }).code ?? "error"}: ${error.message}` : String(error);

const isDeadConnectionError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: string; message?: string };
  if (code && DEAD_CONNECTION_ERROR_CODES.has(code)) return true;
  const text = String(message ?? "").toLowerCase();
  return DEAD_CONNECTION_MESSAGES.some((needle) => text.includes(needle));
};

// Ping before handing the connection back: a ping is a full round trip, so a
// connection that answers it is genuinely alive. destroy() (unlike release())
// drops a dead one from the pool for good instead of returning it to the free
// list to poison the next caller.
const acquireLiveConnection = async (): Promise<PoolConnection> => {
  const attempts = Math.max(config.mysql.connectionLimit, 1) + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const connection = await basePool.getConnection();
    try {
      await connection.ping();
      return connection;
    } catch (error) {
      connection.destroy();
      if (attempt === attempts - 1) throw error;
    }
  }

  throw new Error("mysql: no live connection available");
};

// Applied at the pool layer so every caller is covered without touching call
// sites. Only one retry, and only for connection-level failures, so a genuine
// SQL error still surfaces immediately.
const withDeadConnectionRetry = (method: "query" | "execute") => {
  const runOnPool = basePool[method].bind(basePool) as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;

  return async (...args: unknown[]): Promise<unknown> => {
    try {
      return await runOnPool(...args);
    } catch (error) {
      if (!isDeadConnectionError(error)) throw error;

      console.warn(`[db] stale connection on ${method}, retrying on a fresh one (${describeError(error)})`);
      const connection = await acquireLiveConnection();
      try {
        const runOnConnection = connection[method].bind(connection) as unknown as (
          ...args: unknown[]
        ) => Promise<unknown>;
        return await runOnConnection(...args);
      } finally {
        connection.release();
      }
    }
  };
};

const retryingQuery = withDeadConnectionRetry("query");
const retryingExecute = withDeadConnectionRetry("execute");

export const pool: Pool = new Proxy(basePool, {
  get(target, property, receiver) {
    if (property === "query") return retryingQuery;
    if (property === "execute") return retryingExecute;
    return Reflect.get(target, property, receiver);
  },
});

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

// Idle eviction plus keepalive packets already cover most of it, but an
// otherwise idle app can sit for hours between queries; this exercises the
// pool often enough that a dead connection is discovered and discarded here
// rather than by the next cron write.
export function startPoolKeepalive(): void {
  if (keepaliveTimer || config.mysqlPingIntervalMs <= 0) return;

  keepaliveTimer = setInterval(() => {
    void (async () => {
      try {
        const connection = await acquireLiveConnection();
        connection.release();
      } catch (error) {
        console.warn(`[db] pool keepalive failed (${describeError(error)})`);
      }
    })();
  }, config.mysqlPingIntervalMs);

  keepaliveTimer.unref?.();
}

export function stopPoolKeepalive(): void {
  if (!keepaliveTimer) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

const MIGRATIONS = [
  {
    version: 1,
    name: "create_monitor_groups",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS monitor_groups (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL UNIQUE,
          description TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 2,
    name: "create_monitor_endpoints",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS monitor_endpoints (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_id INT NOT NULL,
          name VARCHAR(120) NOT NULL,
          monitor_type VARCHAR(16) NOT NULL DEFAULT 'http',
          url TEXT NOT NULL,
          method VARCHAR(10) NOT NULL,
          headers_json JSON NULL,
          body_text TEXT NULL,
          expected_status INT NOT NULL,
          expected_json_path VARCHAR(255) NULL,
          expected_json_value TEXT NULL,
          connection_json JSON NULL,
          probe_command TEXT NULL,
          expected_probe_value TEXT NULL,
          interval_seconds INT NOT NULL DEFAULT 60,
          down_retries INT NOT NULL DEFAULT 3,
          up_retries INT NOT NULL DEFAULT 1,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          consecutive_failures INT NOT NULL DEFAULT 0,
          consecutive_successes INT NOT NULL DEFAULT 0,
          last_checked_at DATETIME NULL,
          last_response_code INT NULL,
          last_error TEXT NULL,
          last_match_value TEXT NULL,
          is_paused TINYINT(1) NOT NULL DEFAULT 0,
          next_check_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_monitor_group
            FOREIGN KEY (group_id) REFERENCES monitor_groups(id)
            ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 3,
    name: "create_monitor_check_runs",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS monitor_check_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          endpoint_id INT NOT NULL,
          status VARCHAR(16) NOT NULL,
          response_code INT NULL,
          matched_value TEXT NULL,
          error_message TEXT NULL,
          response_time_ms INT NULL,
          checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_check_endpoint
            FOREIGN KEY (endpoint_id) REFERENCES monitor_endpoints(id)
            ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 4,
    name: "add_monitor_check_runs_indexes",
    up: async () => {
      await pool.query(`
        CREATE INDEX idx_monitor_check_runs_endpoint_checked_at
        ON monitor_check_runs (endpoint_id, checked_at)
      `);
    },
  },
  {
    version: 5,
    name: "create_cron_monitoring",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cron_monitoring (
          cron VARCHAR(100) NOT NULL,
          expression VARCHAR(100) NOT NULL,
          start_window_seconds INT NOT NULL DEFAULT 300,
          ping_window_seconds INT NOT NULL DEFAULT 300,
          status TINYINT(1) NOT NULL DEFAULT 1,
          created_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          modified_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          service VARCHAR(255) NOT NULL DEFAULT '',
          endpoint VARCHAR(256) NOT NULL DEFAULT '',
          trigger_type ENUM('nats','http') DEFAULT 'nats',
          track_run TINYINT(1) NOT NULL DEFAULT 1,
          http_method ENUM('GET','POST','NONE') NOT NULL DEFAULT 'NONE',
          PRIMARY KEY (cron)
        )
      `);
    },
  },
  {
    version: 6,
    name: "seed_cron_monitoring",
    up: async () => {
      // Imported from docs/cron-trigger-monitor.sql: [cron, expression, status].
      // All seed rows share service 'apis', nats trigger, 60s windows, track_run on.
      const seedCrons: Array<[string, string]> = [
        ["change_reqest_replacement_status", "*/5 * * * *"],
        ["charge_instalment", "45 8 * * *"],
        ["charge_subscription", "22 * * * *"],
        ["check_teacher_session_join", "3,33 * * * *"],
        ["concierge_per_day_limit_change", "05 14 * * *"],
        ["daily_group_session_mail_list", "0 * * * *"],
        ["daily_reports", "5 7 * * *"],
        ["daily_sales_leads_reports", "15 8 * * *"],
        ["daily_summary_teacher", "0 * * * *"],
        ["membership_paused", "0 * * * *"],
        ["no_show_first_session", "*/30 * * * *"],
        ["pause_complete_reminder", "0 0 * * *"],
        ["prepaid_recharge_reminder", "0 6 * * *"],
        ["reminder_session_one_day", "*/30 * * * *"],
        ["reminder_session_one_hour", "*/30 * * * *"],
        ["reminders_for_yoga_consults", "*/10 * * * *"],
        ["renew_failed_recurring_transactions", "0 8 * * *"],
        ["repeat_group_session", "0 14 * * *"],
        ["repeat_session", "0 * * * *"],
        ["repeat_session_popup_and_create_roadmap", "*/13 * * * *"],
        ["send_10min_reminder_push", "*/10 * * * *"],
        ["send_gifting_email", "0 * * * *"],
        ["send_session_rating_emails", "*/30 * * * *"],
        ["session_status_reports", "0 */5 * * *"],
        ["single_email_for_session_rating", "*/10 * * * *"],
        ["sort_teacher_availability_by_timezone", "*/6 * * * *"],
        ["start_future_membership", "2 * * * *"],
        ["student_referral", "0 * * * *"],
        ["update_1_day_cron", "5 2 * * *"],
        ["update_1_hour_cron", "15 * * * *"],
        ["update_15_min_cron", "*/15 * * * *"],
        ["update_20_min_cron", "*/20 * * * *"],
        ["update_blast_subject", "0 1 * * *"],
        ["update_daily_teacher_availability_score", "*/30 * * * *"],
        ["update_finish_sessions", "*/5 * * * *"],
        ["weekly_reports", "5 7 * * MON"],
        ["zendesk_sync_profiles", "*/50 */1 * * *"],
      ];

      const values = seedCrons.map(([cron, expression]) => [
        cron,
        expression,
        60,
        60,
        1,
        "apis",
        "",
        "nats",
        1,
        "NONE",
      ]);

      await pool.query(
        `INSERT IGNORE INTO cron_monitoring
          (cron, expression, start_window_seconds, ping_window_seconds, status, service, endpoint, trigger_type, track_run, http_method)
         VALUES ?`,
        [values],
      );
    },
  },
  {
    version: 7,
    name: "add_cron_monitoring_http_request_fields",
    up: async () => {
      await pool.query(`
        ALTER TABLE cron_monitoring
          ADD COLUMN headers_json JSON NULL,
          ADD COLUMN body_text TEXT NULL
      `);
    },
  },
  {
    version: 8,
    name: "add_cron_monitoring_nats_subject",
    up: async () => {
      await pool.query(`
        ALTER TABLE cron_monitoring
          ADD COLUMN nats_subject VARCHAR(255) NOT NULL DEFAULT 'crons.uptime_monitor'
      `);
    },
  },
  {
    version: 9,
    name: "add_cron_scheduling_and_runs",
    up: async () => {
      await pool.query(`
        ALTER TABLE cron_monitoring
          ADD COLUMN next_run_at DATETIME NULL
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cron_runs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          run_id CHAR(36) NOT NULL,
          cron VARCHAR(100) NOT NULL,
          trigger_type ENUM('nats','http') NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'triggered',
          triggered_at DATETIME NOT NULL,
          deadline_at DATETIME NULL,
          first_ping_at DATETIME NULL,
          last_ping_at DATETIME NULL,
          completed_at DATETIME NULL,
          pings INT NOT NULL DEFAULT 0,
          duration_ms INT NULL,
          response_code INT NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_cron_runs_run_id (run_id),
          KEY idx_cron_runs_cron_triggered (cron, triggered_at),
          KEY idx_cron_runs_status_deadline (status, deadline_at),
          CONSTRAINT fk_cron_runs_cron FOREIGN KEY (cron)
            REFERENCES cron_monitoring(cron) ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 10,
    name: "create_app_settings",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          name VARCHAR(100) NOT NULL PRIMARY KEY,
          value VARCHAR(255) NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        INSERT IGNORE INTO app_settings (name, value)
        VALUES ('cron_monitor_enabled', '0')
      `);
    },
  },
  {
    version: 11,
    name: "add_app_settings_updated_by",
    up: async () => {
      await pool.query(`
        ALTER TABLE app_settings
          ADD COLUMN updated_by VARCHAR(255) NULL
      `);
    },
  },
  {
    version: 12,
    name: "create_users",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          google_sub VARCHAR(255) NULL UNIQUE,
          email VARCHAR(255) NOT NULL UNIQUE,
          name VARCHAR(255) NULL,
          picture VARCHAR(1024) NULL,
          role ENUM('admin','editor','viewer') NOT NULL DEFAULT 'viewer',
          is_banned TINYINT(1) NOT NULL DEFAULT 0,
          last_login_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 13,
    name: "create_audit_logs",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          actor_email VARCHAR(255) NULL,
          actor_name VARCHAR(255) NULL,
          action VARCHAR(40) NOT NULL,
          entity_type VARCHAR(40) NOT NULL,
          entity_id VARCHAR(120) NULL,
          entity_label VARCHAR(255) NULL,
          summary VARCHAR(512) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_audit_logs_created (created_at)
        )
      `);
    },
  },
  {
    version: 14,
    name: "create_metric_dimensions",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_nodes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          node_key VARCHAR(128) NOT NULL UNIQUE,
          hostname VARCHAR(255) NULL,
          cpu_cores INT NULL,
          mem_total_bytes BIGINT NULL,
          last_seen DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_metric_nodes_last_seen (last_seen)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_services (
          id INT AUTO_INCREMENT PRIMARY KEY,
          service_name VARCHAR(255) NOT NULL UNIQUE,
          last_seen DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_metric_services_last_seen (last_seen)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_containers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          container_key VARCHAR(128) NOT NULL UNIQUE,
          node_id INT NULL,
          service_id INT NULL,
          name VARCHAR(255) NULL,
          image VARCHAR(512) NULL,
          task_name VARCHAR(255) NULL,
          replica_slot INT NULL,
          stack_namespace VARCHAR(255) NULL,
          cpu_quota_cores DOUBLE NULL,
          mem_limit_bytes BIGINT NULL,
          last_seen DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_metric_containers_last_seen (last_seen),
          KEY idx_metric_containers_service (service_id),
          KEY idx_metric_containers_node (node_id),
          CONSTRAINT fk_metric_containers_node
            FOREIGN KEY (node_id) REFERENCES metric_nodes(id) ON DELETE SET NULL,
          CONSTRAINT fk_metric_containers_service
            FOREIGN KEY (service_id) REFERENCES metric_services(id) ON DELETE SET NULL
        )
      `);
    },
  },
  {
    version: 15,
    name: "create_metric_node_samples",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_node_samples (
          entity_id INT NOT NULL,
          bucket_start DATETIME NOT NULL,
          sample_count INT NOT NULL DEFAULT 0,
          cpu_pct_sum DOUBLE NOT NULL DEFAULT 0,
          cpu_pct_max DOUBLE NOT NULL DEFAULT 0,
          mem_used_sum DOUBLE NOT NULL DEFAULT 0,
          mem_used_max BIGINT NOT NULL DEFAULT 0,
          mem_total_last BIGINT NULL,
          PRIMARY KEY (entity_id, bucket_start)
        )
      `);
    },
  },
  {
    version: 16,
    name: "create_metric_container_samples",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_container_samples (
          entity_id INT NOT NULL,
          bucket_start DATETIME NOT NULL,
          sample_count INT NOT NULL DEFAULT 0,
          cpu_pct_sum DOUBLE NOT NULL DEFAULT 0,
          cpu_pct_max DOUBLE NOT NULL DEFAULT 0,
          mem_used_sum DOUBLE NOT NULL DEFAULT 0,
          mem_used_max BIGINT NOT NULL DEFAULT 0,
          cpu_quota_cores_last DOUBLE NULL,
          mem_limit_bytes_last BIGINT NULL,
          net_rx_last BIGINT NULL,
          net_tx_last BIGINT NULL,
          PRIMARY KEY (entity_id, bucket_start),
          KEY idx_metric_container_samples_bucket (bucket_start)
        )
      `);
    },
  },
  {
    version: 17,
    name: "create_metric_alerts",
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_alert_rules (
          id INT AUTO_INCREMENT PRIMARY KEY,
          scope ENUM('node','service','container') NOT NULL,
          target_key VARCHAR(255) NULL,
          metric ENUM('cpu','memory') NOT NULL,
          operator ENUM('>','>=','<','<=') NOT NULL DEFAULT '>',
          threshold_pct DOUBLE NOT NULL,
          sustained_minutes INT NOT NULL DEFAULT 5,
          cooldown_minutes INT NOT NULL DEFAULT 30,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metric_alert_state (
          rule_id INT NOT NULL,
          entity_key VARCHAR(255) NOT NULL,
          status ENUM('ok','firing') NOT NULL DEFAULT 'ok',
          breaching_since DATETIME NULL,
          last_notified_at DATETIME NULL,
          last_metric_value DOUBLE NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (rule_id, entity_key),
          CONSTRAINT fk_metric_alert_state_rule
            FOREIGN KEY (rule_id) REFERENCES metric_alert_rules(id) ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 18,
    name: "add_cron_health_watchdog",
    up: async () => {
      // Monitor-level health, derived from a dead man's switch rather than from
      // consumed events, so an unhealthy consumer or a stuck queue still shows up.
      await pool.query(`
        ALTER TABLE cron_monitoring
          ADD COLUMN health_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
          ADD COLUMN health_reason VARCHAR(512) NULL,
          ADD COLUMN health_changed_at DATETIME NULL,
          ADD COLUMN last_success_at DATETIME NULL,
          ADD COLUMN stale_after_at DATETIME NULL,
          ADD KEY idx_cron_monitoring_stale (status, stale_after_at)
      `);
      // Reports that arrive after a run was already closed out (queue drained
      // late) are counted here instead of reopening the run.
      await pool.query(`
        ALTER TABLE cron_runs
          ADD COLUMN late_pings INT NOT NULL DEFAULT 0
      `);
    },
  },
];

export type AppSettingRecord = {
  name: string;
  value: string;
  updated_by: string | null;
  updated_at: Date | string | null;
};

export async function getAppSetting(name: string): Promise<string | null> {
  const [rows] = await pool.query<({ value: string } & RowDataPacket)[]>(
    "SELECT value FROM app_settings WHERE name = ? LIMIT 1",
    [name],
  );
  if (!rows.length) return null;
  return String(rows[0].value);
}

export async function getAppSettingRecord(name: string): Promise<AppSettingRecord | null> {
  const [rows] = await pool.query<(AppSettingRecord & RowDataPacket)[]>(
    "SELECT * FROM app_settings WHERE name = ? LIMIT 1",
    [name],
  );
  if (!rows.length) return null;
  return rows[0];
}

export async function setAppSetting(
  name: string,
  value: string,
  updatedBy: string | null = null,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO app_settings (name, value, updated_by)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)
    `,
    [name, value, updatedBy],
  );
}

async function ensureSchemaMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedVersions(): Promise<Set<number>> {
  const [rows] = await pool.query<({ version: number } & RowDataPacket)[]>(
    "SELECT version FROM schema_migrations",
  );
  return new Set(rows.map((row) => Number(row.version)));
}

export async function initDatabase(): Promise<void> {
  await ensureSchemaMigrationsTable();
  const appliedVersions = await getAppliedVersions();

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    await migration.up();
    await pool.query(
      "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
      [migration.version, migration.name],
    );
  }

  startPoolKeepalive();
}
