FROM node:24-trixie AS base

RUN npm install --global pnpm@12.4.2

WORKDIR /app

FROM base AS deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/uncloud/package.json packages/uncloud/package.json
COPY packages/workflows/package.json packages/workflows/package.json
COPY patches ./patches

RUN --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

FROM deps AS build

COPY . .

RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local,required=false \
    --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    export NODE_ENV=production APP_SECRET=build-only-secret-that-is-not-used-at-runtime APP_URL=http://localhost:3001 DATABASE_URL=postgresql://build:build@localhost:5432/build \
    && pnpm install --prod=false --offline --frozen-lockfile --store-dir /pnpm/store \
    && pnpm --filter web build \
    && pnpm deploy --filter web --prod /app/runtime --legacy

FROM node:24-alpine AS runtime

# Git operations use both HTTPS and SSH at runtime.
RUN apk add --no-cache ca-certificates git openssh-client \
    && npm install --global pnpm@12.4.2

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

COPY --from=build --chown=node:node /app/runtime ./
COPY --from=build --chown=node:node /app/apps/web/build ./build
COPY --from=build --chown=node:node /app/apps/web/src/generated-env.ts ./src/generated-env.ts
COPY --from=build --chown=node:node /app/apps/web/drizzle.config.ts ./drizzle.config.ts

# adapter-node's build is self-contained; static assets are already in build.
# Keep src because varlock uses its generated environment types at startup.
RUN rm -rf static

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3001/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "build/index.js"]
