# Uptime Monitor

Uptime Monitor is a single-service uptime platform for monitoring HTTP APIs, MySQL, Redis, NATS JetStream, and TCP ports — plus container and VM level infrastructure metrics (CPU, memory, network) collected from Docker hosts by a lightweight sidecar.

![Uptime Control Panel](images/screenshot_control_panel.png)
![Status Page - Monitored Services](images/screenshot_status_page.png)
![Status Page - Cron Health](images/screenshot_cron_health.png)
![Audit Log](images/screenshot_audit_log.png)

It uses:

- Frontend: React + Vite + Tailwind
- Backend: Express on Bun
- Storage: MySQL
- Realtime updates: WebSocket (`/ws`)

The backend serves the built frontend (`dist/`) so both control plane and status page can be deployed together.

## Features

One service that watches your APIs, databases, message bus, and cron jobs — and tells you the moment something goes wrong.

- **Five monitor types** — HTTP(S), MySQL, Redis, NATS JetStream, and TCP ports, each with per-monitor intervals and optional probe commands with expected-value matching.
- **Deep HTTP checks** — custom method, headers, and body; assert on status code or a nested JSON path in the response.
- **NATS JetStream consumer lag detection** — flags consumers whose backlog exceeds a threshold (global, per-monitor, or per-consumer), and is smart enough not to alert on a consumer that is already draining.
- **Cron monitoring** — schedules and fires your crons over NATS or HTTP, then tracks each run through start/ping/stop reports; runs that never report or go silent past their deadline are marked missed and alerted on.
- **Retry-aware health transitions** — configurable retries before marking down or back up, so a single blip never pages anyone.
- **Realtime control plane and status page** — WebSocket pushes every check result and config change to all open tabs; the public status page shows grouped service health, latency trend graphs, and cron run history.
- **Container & VM metrics** — a lightweight sidecar (one per Docker Swarm node, or any standalone Docker VM) pushes host CPU/memory and per-container CPU, memory, and network usage every 15s. The dashboard keeps 90 days of minute-resolution history with drill-down from VM → service → replica/container, and plots usage against allotted CPU quota and memory limits.
- **Metric threshold alerts** — rules on CPU% / memory% at node, service, or container scope with sustained-duration windows and cooldowns; firing and resolved notifications go through the same Slack/webhook channels.
- **Alerts where you live** — rich Slack notifications and pluggable webhooks on up/down transitions and failed/missed cron runs.
- **Built for operating** — pause/resume single monitors or whole groups, manual "check now", per-monitor history cleanup, Google sign-in with an editor email allowlist, versioned DB migrations, and one-command Docker deploy.

## Pages

- `/` landing page
- `/monitors` control plane
- `/metrics` container & VM metrics dashboard (logged-in users)
- `/status` public status page
- `/login` Google sign-in page

## Environment

Use `.env` (see `.env.example`):

- `NODE_ENV`
- `TZ`
- `PORT`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `MYSQL_CONNECTION_LIMIT`
- `MONITOR_POLL_MS`
- `REQUEST_TIMEOUT_MS`
- `NATS_LAG_THRESHOLDS`
- `CORS_ORIGINS`
- `VITE_API_BASE_URL`
- `SESSION_SECRET`
- `SESSION_MAX_AGE_MS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `GOOGLE_HOSTED_DOMAIN`
- `CONTROL_PLANE_PATH`
- `LOGIN_PATH`
- `TRUST_PROXY`
- `CONTROL_PLANE_ADMIN_EMAILS`
- `ALLOW_NEW_ACCOUNTS`
- `NOTIFICATIONS_ENABLED`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`
- `NOTIFICATION_TARGETS_JSON`
- `METRICS_INGEST_TOKEN`
- `METRIC_RETENTION_DAYS`
- `METRIC_DIMENSION_PRUNE_DAYS`
- `METRIC_ALERT_POLL_MS`

Access control:

- Roles are stored per user in the database (`admin`, `editor`, `viewer`) and managed from the in-app **Users** console (admin only). Admins can change roles and ban/unban users.
- `editor`/`admin` can mutate monitors, groups, and crons; `viewer` is read-only. `admin` additionally manages users.
- Set `CONTROL_PLANE_ADMIN_EMAILS` as a comma-separated list of Google account emails to seed the initial admins.
- Example: `CONTROL_PLANE_ADMIN_EMAILS=ops@company.com,sre@company.com`
- These emails are inserted as admins on startup (and re-asserted to admin + un-banned on every boot, so a configured admin can always recover access). A row is created without a Google ID and claimed by email at first login.
- If empty and no admin exists yet, the Users console is unreachable — set at least one admin email before locking down access.
- `ALLOW_NEW_ACCOUNTS` (default `true`): when `true`, anyone who signs in with Google and isn't already known is created with the `viewer` role. When `false`, only users who already exist in the `users` table (invited from the Users console, or seeded admins) can sign in — everyone else is denied at login. Admins seeded via `CONTROL_PLANE_ADMIN_EMAILS` are always allowed regardless of this setting.

Audit log:

- All changes to monitors, groups, crons, and users are recorded in an audit log, viewable by admins under the **Audit Log** section.
- Admins can truncate the log by retention window (keep last 3 months / 1 month / 1 week / 1 day) or clear it entirely.

Session storage:

- Sessions are persisted in MySQL (table managed by `express-mysql-session`).
- Default login validity is 1 day (`SESSION_MAX_AGE_MS=86400000`).

Notification config examples:

```env
NOTIFICATIONS_ENABLED=true
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_CHANNEL_ID=C0123456789
NOTIFICATION_TARGETS_JSON=[]
```

```env
NOTIFICATION_TARGETS_JSON=[{"name":"ops-slack","type":"slack","token":"xoxb-your-bot-token","channel":"C0123456789","events":["down","up"]},{"name":"incident-webhook","type":"webhook","url":"https://example.com/hooks/uptime","events":["down"],"headers":{"Authorization":"Bearer token"}}]
```

## Getting Started (Local Development)

1. Install dependencies:

```bash
bun install
```

2. Configure env:

```bash
cp .env.example .env
```

3. Update `.env` for your local infrastructure (MySQL required, Redis/NATS optional based on monitor types).

4. Run frontend + backend:

```bash
bun run dev
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend/API: `http://localhost:8000`

## Build and Run (Single Service)

Build frontend and run backend serving `dist/`:

```bash
bun run build
bun run start
```

## Docker Deployment

Build and start full stack:

```bash
docker compose up -d --build
```

Services:

- App: `http://localhost:8000`
- MySQL: `localhost:3306`

Stop:

```bash
docker compose down
```

Stop and remove volumes:

```bash
docker compose down -v
```

## NPM/Bun Scripts

- `bun run dev` - run client + server in watch mode
- `bun run dev:client` - run Vite dev server
- `bun run dev:server` - run Bun server in watch mode
- `bun run build` - build frontend
- `bun run start` - run production backend (serves built frontend)
- `bun run lint` - run ESLint
- `bun run preview` - preview Vite build

## How Monitoring Works

- Monitor loop selects due monitors (`next_check_at`) and runs checks.
- Check results are stored in `monitor_check_runs`.
- Endpoint health state is updated with retry-aware transitions.
- WebSocket events push monitor/group/endpoint changes to connected clients.

NATS JetStream probe commands (set as the monitor's probe command):

- `jetstream.info`, `stream.info:<name>` - account/stream health
- `consumers.lag[:<threshold>]` - lag check across all consumers; `consumer.lag:<stream>:<consumer>[:<threshold>]` for one
- A consumer is flagged when `num_ack_pending`, `num_pending`, or `num_waiting` exceeds the threshold (default 128). Override per consumer via `"lag_thresholds": { "my_consumer": 1024, "default": 128 }` in Connection JSON, or globally with `NATS_LAG_THRESHOLDS` (Connection JSON wins). Draining consumers (backlog shrinking since the last check) are not flagged.

## Container & VM Metrics

Infrastructure metrics are pushed by the collector in [`sidecar-swarm/`](sidecar-swarm/README.md) — a zero-dependency Bun service deployed as a Docker Swarm `mode: global` stack (one instance per node) or as a plain container on any standalone Docker VM.

- The sidecar reads the Docker socket and the host's `/proc` (read-only mounts) and POSTs one batch per node every 15s to `POST /api/metrics/ingest`, authenticated with a Bearer token (`METRICS_INGEST_TOKEN` — must match on both sides; ingest is disabled until it is set).
- Samples are rolled up into 1-minute buckets on ingest and retained for `METRIC_RETENTION_DAYS` (default 90). Containers unseen for `METRIC_DIMENSION_PRUNE_DAYS` (default 7) are pruned along with their history.
- The `/metrics` page shows VM-level charts on top and a services table below, with **By Node** and **By Service** views drilling down to per-replica, minute-level charts. Allotted CPU quota and memory limits are drawn as reference lines so you can see % used vs allotted over time.
- Alert rules (node / service / container scope, CPU% or memory%, sustained-minutes window, cooldown) are managed from the same page by editors and delivered via the configured Slack/webhook targets.

See [`sidecar-swarm/README.md`](sidecar-swarm/README.md) for the payload contract, sidecar env vars, and deploy instructions.

## Database Migrations

`server/db.ts` uses versioned migrations.

- Applied versions are stored in `schema_migrations`.
- Only pending migrations run at startup.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Author

* Pankaj Soni<pankajsoni19@live.com>
