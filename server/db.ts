import mysql from 'mysql2/promise'
import { config } from './config'

export const pool: any = mysql.createPool({
  ...config.mysql,
  waitForConnections: true,
})

const MIGRATIONS = [
  {
    version: 1,
    name: 'create_monitor_groups',
    up: async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS monitor_groups (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(120) NOT NULL UNIQUE,
          description TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `)
    },
  },
  {
    version: 2,
    name: 'create_monitor_endpoints',
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
      `)
    },
  },
  {
    version: 3,
    name: 'create_monitor_check_runs',
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
      `)
    },
  }
]

async function ensureSchemaMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function getAppliedVersions() {
  const [rows] = await pool.query('SELECT version FROM schema_migrations')
  return new Set(rows.map((row) => Number(row.version)))
}

export async function initDatabase() {
  await ensureSchemaMigrationsTable()
  const appliedVersions = await getAppliedVersions()

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue

    await migration.up()
    await pool.query('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
      migration.version,
      migration.name,
    ])
  }
}
