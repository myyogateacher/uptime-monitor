# uptime-monitor swarm metrics sidecar

A lightweight infrastructure-metrics collector for [uptime-monitor](../). It
runs as a Docker Swarm **global-mode** service — one instance per node — and on
a fixed interval it:

1. Reads the local Docker Engine API over the unix socket for the list of
   running containers and their `stats` (CPU / memory / network) plus a cached
   `inspect` (CPU quota / memory limit).
2. Reads host VM metrics from the bind-mounted `/proc` (CPU% via `/proc/stat`
   jiffies delta, memory from `/proc/meminfo`, load from `/proc/loadavg`).
3. Builds one batch and POSTs it to the uptime-monitor server ingest endpoint
   with a Bearer token.

**Bun + TypeScript, zero npm dependencies.** Bun's `fetch` talks to the Docker
socket natively via the `unix` option, so there is no HTTP-client dependency
and no build step — Bun runs `src/index.ts` directly.

## Payload contract

The wire format is defined in [`src/types.ts`](./src/types.ts)
(`MetricsIngestPayload`) and mirrored server-side in
`server/metricsService.ts`. **Keep the two in sync.** One node per request,
~10-15 KB. Net counters are cumulative — the server computes rates at query
time.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `METRICS_INGEST_URL` | `https://uptime.example.com/api/metrics/ingest` | Server ingest endpoint. |
| `METRICS_INGEST_TOKEN` | — | Bearer token. Ignored if the `_FILE` variant is set. |
| `METRICS_INGEST_TOKEN_FILE` | — | Path to a file holding the token (Docker secret). **Takes precedence**; read once at startup. |
| `METRICS_INTERVAL_MS` | `15000` | Collection interval (self-scheduling; no overlap). |
| `HTTP_TIMEOUT_MS` | `10000` | Timeout for both Docker and ingest requests. |
| `STATS_CONCURRENCY` | `8` | Max parallel `/stats` calls per tick. |
| `BUFFER_MAX_BATCHES` | `60` | Ring-buffer size on ingest failure (~15 min at 15s). Oldest dropped, count reported next success. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine API unix socket. |
| `DOCKER_API_VERSION` | — (unversioned) | Optional Engine API version prefix (e.g. `v1.44`). Unversioned requests use the daemon's native version. |
| `HOST_PROC` | `/host/proc` | Bind-mounted host `/proc`. |
| `NODE_NAME` | — | Override the reported hostname (defaults to `/info` `Name`). |
| `INSPECT_CACHE_MS` | `300000` | How long container quota/limit inspects are cached. |
| `INFO_REFRESH_MS` | `3600000` | How often node identity (`/info`) is refreshed. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Deploy (Docker Swarm)

Build and push the image, then create the token secret and deploy the stack:

```sh
# 1. Build + push (from this directory)
docker build -t registry.example.com/uptime-sidecar-swarm:latest .
docker push registry.example.com/uptime-sidecar-swarm:latest

# 2. Create the ingest token as a Docker secret
printf '%s' 'YOUR_INGEST_TOKEN' | docker secret create metrics_ingest_token -

# 3. Deploy the global-mode stack
IMAGE=registry.example.com/uptime-sidecar-swarm:latest \
  docker stack deploy -c deploy/uptime-metrics-stack.yml uptime-metrics
```

The stack ([`deploy/uptime-metrics-stack.yml`](./deploy/uptime-metrics-stack.yml))
runs `mode: global`, `restart_policy.condition: any` (delay 5s), resource
limits `cpus: 0.25 / memory: 128M` (reservations `0.02 / 32M`), read-only bind
mounts of `/var/run/docker.sock` and `/proc → /host/proc`, and injects the
token via the external secret using `METRICS_INGEST_TOKEN_FILE`.

### Standalone VM (no swarm)

The collector also works on any plain Docker host. When the swarm labels are
absent, service identity falls back automatically (swarm > compose > name):

- **docker-compose** containers group by their `com.docker.compose.service`
  under the compose project (`com.docker.compose.project`), with the replica
  slot taken from `com.docker.compose.container-number` — so a compose service
  shows up as a named, multi-replica service just like a swarm service.
- **bare `docker run`** containers (no orchestration labels) are named after the
  container itself, with trailing machine-generated segments stripped — a full
  UUID, a hex blob of 8+ chars, or a mostly-digits timestamp-like suffix. So
  `recorder-3f9a12ab-77c1-4e2b-9d10-aa12bc34de56` and its siblings all group
  under one `recorder` service instead of one single-replica service each,
  while deliberate suffixes like `worker-2` are left alone. The full container
  name is kept as the task name, so each instance stays identifiable in the
  replicas drill-down.

Either way every container is now drillable under the Services table, not just
in the VM-level metrics and container count. Use
[`deploy/docker-compose.yml`](./deploy/docker-compose.yml):

```sh
METRICS_INGEST_TOKEN=YOUR_INGEST_TOKEN NODE_NAME=my-vm-01 \
  docker compose -f deploy/docker-compose.yml up -d
```

Outside a swarm there are no Docker secrets, so the token is passed via env
(or a `.env` file next to the compose file). `NODE_NAME` gives the VM a stable
display name; without it the daemon hostname is used.

Rotate the token by recreating the secret and redeploying (a `docker secret` is
immutable):

```sh
docker service update --secret-rm metrics_ingest_token uptime-metrics_metrics-sidecar
docker secret rm metrics_ingest_token
printf '%s' 'NEW_TOKEN' | docker secret create metrics_ingest_token -
docker service update --secret-add metrics_ingest_token uptime-metrics_metrics-sidecar
```

## Local development

```sh
# Requires a reachable Docker daemon and (for host metrics) a readable /proc.
DOCKER_SOCKET=/var/run/docker.sock \
HOST_PROC=/proc \
METRICS_INGEST_URL=http://localhost:3001/api/metrics/ingest \
METRICS_INGEST_TOKEN=dev-token \
LOG_LEVEL=debug \
  bun src/index.ts
```

`docker swarm init` locally so containers carry the
`com.docker.swarm.*` labels the collector reads. On macOS `/proc` does not
exist, so host CPU/mem come back null/0 — run inside a Linux VM for full host
metrics. Typecheck with `bun run typecheck`.

## Footprint

Bun idles around ~60-90 MB RSS — comfortably inside the 128 MB limit. CPU is
negligible between ticks. Per tick: one `/containers/json`, up to
`STATS_CONCURRENCY` parallel `/stats?stream=false` (single-shot, no streaming
state), cached inspects, and one outbound POST.

### Go-rewrite fallback

If the per-node memory footprint ever matters (dense nodes, many collectors),
the same collector reimplemented as a Go static binary lands around ~10 MB RSS.
The wire contract in `src/types.ts` is the stable boundary, so a rewrite is a
drop-in on the sidecar side with no server changes. Bun was chosen first
because the team already runs Bun/TypeScript and it keeps one language across
the stack.
