// Environment parsing for the swarm metrics sidecar. Mirrors the style of
// server/config.ts (small typed coercion helpers + one frozen `config`
// object). Zero npm deps — reads process.env directly, no dotenv.

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toString = (value: unknown, fallback: string): string => {
  const str = String(value ?? "").trim();
  return str || fallback;
};

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

const parseLogLevel = (value: unknown, fallback: LogLevel): LogLevel => {
  const level = String(value ?? "")
    .trim()
    .toLowerCase();
  return (LOG_LEVELS as string[]).includes(level)
    ? (level as LogLevel)
    : fallback;
};

// The ingest token comes either inline (METRICS_INGEST_TOKEN) or from a file
// (METRICS_INGEST_TOKEN_FILE — the Docker secret path). File takes precedence
// and is read once at startup.
const readIngestToken = (): string => {
  const filePath = String(process.env.METRICS_INGEST_TOKEN_FILE ?? "").trim();
  if (filePath) {
    try {
      const contents = require("node:fs").readFileSync(filePath, "utf8");
      const token = String(contents).trim();
      if (token) return token;
      console.error(`[config] METRICS_INGEST_TOKEN_FILE ${filePath} is empty`);
    } catch (err) {
      console.error(
        `[config] failed to read METRICS_INGEST_TOKEN_FILE ${filePath}:`,
        err,
      );
    }
  }
  return String(process.env.METRICS_INGEST_TOKEN ?? "").trim();
};

export const COLLECTOR_VERSION = "0.1.0";

export const config = {
  logLevel: parseLogLevel(process.env.LOG_LEVEL, "info"),

  ingestUrl: toString(
    process.env.METRICS_INGEST_URL,
    "https://uptime.example.com/api/metrics/ingest",
  ),
  ingestToken: readIngestToken(),

  intervalMs: toNumber(process.env.METRICS_INTERVAL_MS, 15000),
  httpTimeoutMs: toNumber(process.env.HTTP_TIMEOUT_MS, 10000),
  statsConcurrency: Math.max(1, toNumber(process.env.STATS_CONCURRENCY, 8)),
  bufferMaxBatches: Math.max(1, toNumber(process.env.BUFFER_MAX_BATCHES, 60)),

  dockerSocket: toString(process.env.DOCKER_SOCKET, "/var/run/docker.sock"),
  // Optional Docker Engine API version prefix (e.g. "v1.44"). Empty means
  // unversioned requests, which every daemon serves at its native version —
  // new engines reject pinned versions they consider too old.
  dockerApiVersion: toString(process.env.DOCKER_API_VERSION, ""),

  hostProc: toString(process.env.HOST_PROC, "/host/proc"),
  // Optional override for the node hostname reported to the server.
  nodeName: String(process.env.NODE_NAME ?? "").trim(),

  // How long a container inspect result stays cached before re-fetching quota/limit.
  inspectCacheMs: toNumber(process.env.INSPECT_CACHE_MS, 5 * 60 * 1000),
  // How often to refresh cached /info (node identity).
  infoRefreshMs: toNumber(process.env.INFO_REFRESH_MS, 60 * 60 * 1000),
} as const;

export type Config = typeof config;

// --- Simple structured console logging, gated by LOG_LEVEL -----------------

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const emit = (
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>,
): void => {
  if (LEVEL_RANK[level] < LEVEL_RANK[config.logLevel]) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta ?? {}) };
  const out =
    level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
};

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) =>
    emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) =>
    emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) =>
    emit("error", msg, meta),
};
