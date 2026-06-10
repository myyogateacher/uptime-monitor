import mysql from "mysql2/promise";
import { config } from "./config";

export const pool: any = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
});

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
];

export type AppSettingRecord = {
  name: string;
  value: string;
  updated_by: string | null;
  updated_at: Date | string | null;
};

export async function getAppSetting(name: string): Promise<string | null> {
  const [rows] = await pool.query("SELECT value FROM app_settings WHERE name = ? LIMIT 1", [name]);
  if (!rows.length) return null;
  return String(rows[0].value);
}

export async function getAppSettingRecord(name: string): Promise<AppSettingRecord | null> {
  const [rows] = await pool.query("SELECT * FROM app_settings WHERE name = ? LIMIT 1", [name]);
  if (!rows.length) return null;
  return rows[0] as AppSettingRecord;
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

async function ensureSchemaMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function getAppliedVersions() {
  const [rows] = await pool.query("SELECT version FROM schema_migrations");
  return new Set(
    (rows as { version: number }[]).map((row) => Number(row.version)),
  );
}

export async function initDatabase() {
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
}
