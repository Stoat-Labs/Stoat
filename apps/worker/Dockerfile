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

# The bundle is self-contained, so the runtime is just Node (24, same as the web image) and the
# git/ssh clients the Git watcher shells out to.
FROM alpine:3.24 AS runtime

RUN apk add --no-cache nodejs git openssh-client ca-certificates

COPY --from=build /app/apps/worker/dist/worker.mjs /app/worker.mjs

ENV NODE_ENV=production
USER nobody
CMD ["node", "/app/worker.mjs"]
