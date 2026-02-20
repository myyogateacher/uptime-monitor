# Uptime Monitor

Uptime Monitor is a single-service uptime platform for monitoring HTTP APIs, MySQL, Redis, NATS JetStream, and TCP ports.

![Uptime Control Panel](images/screenshot_control_panel.png)
![Uptime Control Panel](images/screenshot_status_page.png)

It uses:
- Frontend: React + Vite + Tailwind
- Backend: Express on Bun
- Storage: MySQL
- Realtime updates: WebSocket (`/ws`)

The backend serves the built frontend (`dist/`) so both control plane and status page can be deployed together.

## Features

- HTTP monitor support:
  - Full URL endpoint
  - HTTP method
  - Optional headers JSON
  - Optional request body
  - Expected HTTP status code validation
  - Nested JSON path + expected value matching
- MySQL monitor support:
  - Connection JSON
  - Optional probe SQL
  - Optional expected probe value matching
- Redis monitor support:
  - Connection JSON
  - Optional probe command
  - Optional expected probe value matching
- NATS JetStream monitor support:
  - Connection JSON
  - JetStream probe command support (`jetstream.info`, `stream.info:<name>`)
  - Optional expected probe value matching
- TCP port monitor support:
  - Host/port connection check
  - Optional expected probe value matching (default `"open"`)
- Retry-based health transitions:
  - Interval per monitor
  - Retries before marking down
  - Retries before marking up
- Pause/resume monitors
- Pause/resume entire groups
- Manual "Check now"
- Google-only login for control plane
- In-memory backend sessions
- Rich Slack notifications for up/down transitions
- Pluggable webhook notifications for any custom endpoint
- Group monitors by logical groups
- Edit monitor configuration
- Delete monitor historical runs per monitor
- Realtime updates over WebSocket across tabs/sessions
- Status page with grouped services and latency graph (with hover tooltip)
- Glass-style SaaS UI
- DB schema versioning via `schema_migrations`
- Docker deployment with app + MySQL

## Pages

- `/` landing page
- `/monitors` control plane
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
- `NOTIFICATIONS_ENABLED`
- `SLACK_BOT_TOKEN`
- `SLACK_CHANNEL_ID`
- `NOTIFICATION_TARGETS_JSON`

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

## Database Migrations

`server/db.ts` uses versioned migrations.

- Applied versions are stored in `schema_migrations`.
- Only pending migrations run at startup.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
