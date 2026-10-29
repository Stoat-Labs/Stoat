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
COPY packages/s3/package.json packages/s3/package.json
COPY packages/uncloud/package.json packages/uncloud/package.json
COPY packages/workflows/package.json packages/workflows/package.json
COPY patches ./patches

RUN --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

FROM deps AS build

COPY . .

# Shown in the sidebar footer. Without APP_VERSION this is a "-dev" build.
ARG GIT_COMMIT
ARG APP_VERSION

RUN --mount=type=secret,id=web_env,target=/app/apps/web/.env.local,required=false \
    --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    export NODE_ENV=production APP_SECRET=build-only-secret-that-is-not-used-at-runtime APP_URL=http://localhost:3001 DATABASE_URL=postgresql://build:build@localhost:5432/build \
    && pnpm install --prod=false --offline --frozen-lockfile --store-dir /pnpm/store \
    && pnpm --filter @stoat/stoat build \
    && pnpm deploy --filter @stoat/stoat --prod /app/runtime --legacy

# The Uncloud CLI that ProvisionCluster uses to create clusters over SSH. Keep the version in sync
# with github.com/psviderski/uncloud in apps/sidecar/go.mod, and the hashes with its checksums.txt.
FROM alpine:3.23.3 AS uc

ARG TARGETARCH
ARG UNCLOUD_VERSION=0.21.0
ARG UC_SHA256_amd64=11a87551d31144a5837c04d87d4f984c2a62b29052bb3a29d2a5cb72be7de616
ARG UC_SHA256_arm64=f9416a97a409865238e8a7be5ad4a0441cc8523c8f33967a9a87eea27109d47e

RUN apk --no-cache add curl \
    && curl -fsSL --retry 3 -o /tmp/uc.tar.gz \
        "https://github.com/psviderski/uncloud/releases/download/v${UNCLOUD_VERSION}/uc_linux_${TARGETARCH}.tar.gz" \
    && eval "sha=\$UC_SHA256_${TARGETARCH}" \
    && echo "${sha}  /tmp/uc.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/uc.tar.gz -C /usr/local/bin uc

FROM node:24-alpine AS runtime

# Git operations use both HTTPS and SSH at runtime.
RUN apk add --no-cache ca-certificates git openssh-client \
    && npm install --global pnpm@12.4.2

COPY --from=uc /usr/local/bin/uc /usr/local/bin/uc

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

COPY --from=build --chown=node:node /app/runtime ./
COPY --from=build --chown=node:node /app/apps/web/build ./build
COPY --from=build --chown=node:node /app/apps/web/server.js ./server.js
COPY --from=build --chown=node:node /app/apps/web/src/generated-env.ts ./src/generated-env.ts
COPY --from=build --chown=node:node /app/apps/web/drizzle.config.ts ./drizzle.config.ts

# adapter-node's build is self-contained; static assets are already in build.
# Keep src because varlock uses its generated environment types at startup.
RUN rm -rf static

USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3001/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
# adapter-node assumes https unless ORIGIN is set, which breaks Better Auth on a plain
# http APP_URL. APP_URL is the public URL, so it is the right default origin.
CMD ["sh", "-c", "export ORIGIN=\"${ORIGIN:-$APP_URL}\" && exec node server.js"]
