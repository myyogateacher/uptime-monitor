# Uptime Monitor

React + Vite + Tailwind frontend with an Express + Bun backend using MySQL storage.

## Features

- Monitor HTTP endpoints with full URL, method, headers, and body
- Validate expected HTTP response code
- Validate nested JSON value by path (e.g. `data.status` or `items[0].id`)
- Monitor MySQL with connection config JSON plus optional probe SQL/value matching
- Monitor Redis with connection config JSON plus optional probe command/value matching
- Configure interval, retries before down, and retries before up
- Group routes by logical monitor groups
- Serve frontend static build from `dist/` in the same backend service

## Environment

Set values in `.env` (already added):

- `NODE_ENV`
- `PORT`
- `MYSQL_HOST`
- `MYSQL_PORT`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATABASE`
- `MYSQL_CONNECTION_LIMIT`
- `MONITOR_POLL_MS`
- `REQUEST_TIMEOUT_MS`
- `VITE_API_BASE_URL`

## Install

```bash
bun install
```

## Run in Development

```bash
bun run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001/api`

## Production-style Run (single service)

```bash
bun run build
bun run start
```

This serves API routes and frontend static assets from `dist/` via Express.
