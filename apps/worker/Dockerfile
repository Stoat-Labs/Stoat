FROM node:24-trixie AS build

RUN npm install --global pnpm@12.4.2

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches

RUN --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store

COPY . .

# Install scripts only generate web env types and SvelteKit files, which the worker never uses.
RUN --mount=type=cache,id=stoat-pnpm,target=/pnpm/store \
    pnpm install --prod=false --offline --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
    && pnpm --filter @stoat/worker build

# The Uncloud CLI that ProvisionCluster uses to create clusters over SSH. Keep the version and
# hashes the same as in apps/web/Dockerfile.
FROM alpine:3.24 AS uc

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

# The bundle is self-contained, so the runtime is just Node (24, same as the web image), the
# git/ssh clients the Git watcher and cluster setup shell out to, and uc.
FROM alpine:3.24 AS runtime

RUN apk add --no-cache nodejs git openssh-client ca-certificates

COPY --from=uc /usr/local/bin/uc /usr/local/bin/uc
COPY --from=build /app/apps/worker/dist/worker.mjs /app/worker.mjs

ENV NODE_ENV=production
USER nobody
CMD ["node", "/app/worker.mjs"]
