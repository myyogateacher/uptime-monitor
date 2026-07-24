# Swarm metrics sidecar. Zero npm deps => no install/build step; Bun runs the
# TypeScript source directly.
FROM oven/bun:1-slim

WORKDIR /app

# Copy only what the runtime needs.
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    TZ=UTC

# No ports exposed — the sidecar only makes outbound calls (docker socket + ingest).
CMD ["bun", "src/index.ts"]
