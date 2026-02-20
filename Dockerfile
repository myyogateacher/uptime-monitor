FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build

FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=UTC
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json bun.lock ./
COPY server ./server

EXPOSE 8000
CMD ["bun", "run", "start:server"]
