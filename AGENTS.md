# Clowder

No vendor lock-in PaaS dashboard on top of Uncloud. pnpm monorepo, driven by **vite-plus (`vp`)**, not plain vite/vitest/eslint/prettier.

## Layout

- `apps/web`: SvelteKit app (adapter-node). The browser calls oRPC over one WebSocket at `/rpc` (`src/lib/server/rpc-socket.ts`, attached by `server.js` in production and `rpc-socket-plugin.ts` in dev); `src/routes/rpc/[...rest]` only serves the REST API for API keys. Starts the effect-mq worker from `hooks.server.ts` (never during build) unless `USE_INTERNAL_WORKER=false`.
- `apps/sidecar`: Go HTTP API wrapping Uncloud; runs as root on cluster machines. `cmd/openapi` emits its OpenAPI spec. `/api/v1/cluster/connect` upgrades to a raw connection to the Uncloud API (how the worker runs `uc` against a cluster), `/api/v1/services/{id}/spread` starts a global service on machines that have none, never touching existing containers, `DELETE /api/v1/machines/{id}` removes a machine like `uc machine rm`, refusing the one it connects through, and `PUT /api/v1/cluster/domain/records` points the reserved domain at the machines whose Caddy answers, like uc after deploying Caddy.
- `apps/worker`: standalone worker image (`ghcr.io/clowder-run/worker`) for `USE_INTERNAL_WORKER=false`. Vite bundles `src/index.ts` and every dependency into one `dist/worker.mjs`; the image is Alpine with Node, git, ssh and `uc`. Both it and `apps/web` start the worker through `@clowder/api/worker`.
- `packages/api`: oRPC routers and business logic. Packages export `src/*.ts` directly; `dist/` is only `tsc -b` output.
- `packages/db`: Drizzle schema and queries. Migrations live in `packages/db/src/migrations` and **also include** `packages/workflows/src/schema.ts` (effect-mq tables).
- `packages/workflows`: effect-mq jobs (`InitializeCluster`, `DeployResource`, `ReconcileBucket`, `ProvisionCluster`, `AddMachine`). `internal/monitoring/compose.yaml` is the monitoring stack it deploys; `internal/sidecar/compose.yaml` is the sidecar `ProvisionCluster` deploys to clusters it creates over SSH with the `uc` CLI: HTTPS on port 51443 with a self-signed certificate pinned in `clusters.sidecar_certificate`. The cluster row exists from the start; its setup state sits in `clusters.provisioning` (keys in the encrypted `provisioning_secrets`) until it's ready, and each attempt is a `ProvisionCluster` deployment. A server being added to a ready cluster sits in `clusters.pending_machine` (key in the encrypted `pending_machine_key`); each `AddMachine` attempt runs `uc machine add` through the sidecar's connect relay on a private Unix socket, then spreads the sidecar, Caddy and Alloy to the new machine and, for a public one, points the reserved domain at it.
- `packages/s3`: S3 providers (Generic, RustFS, R2) and the AWS SDK client behind `/s3` connections and `bucket` resources. `src/providers/index.ts` is the client-safe catalog; the other provider files are server-only.
- `packages/uncloud`: TS client for the sidecar. `openapi.json` and `src/generated/` are committed artifacts.
- `packages/config`: shared `tsconfig.base.json` and `src/env.ts`, the one place packages read env.
- `packages/trees`: Svelte 5 bindings for `@pierre/trees` (`<FileTree>`, `createFileTree`, reactive selection/search). Tests in `tests/trees` run and type-check from this package.
- `tests/`: all TS tests live here (`api`, `uncloud`, `workflows`, `web`), not beside the source. Go tests stay in `apps/sidecar`.

## Commands

- `pnpm check`: lint, then `vp fmt --write`. `pnpm check-types`: `tsc -b` / `svelte-check` in every package.
- `pnpm test`: runs three separate configs, root `vite.config.ts` (api/uncloud/workflows), `apps/web/vite.config.ts` (tests/web) and `packages/trees/vite.config.ts` (tests/trees).
- Single test: `pnpm exec vp test run tests/api/git.test.ts`. For web tests: `pnpm --dir apps/web exec vp test run ../../tests/web/<file>.test.ts`. For tree tests (needs its Svelte plugin and jsdom): `pnpm --dir packages/trees exec vp test run ../../tests/trees/<file>.test.ts`.
- Go: `go -C apps/sidecar test ./...`.
- After changing sidecar routes or schemas: `pnpm uc:refresh` (needs Go) and commit both `openapi.json` and the generated types.
- DB: `pnpm db:start` runs `compose.dev.yaml` (Postgres on host port **5435**, Dragonfly on **6380**); `pnpm dev` runs it plus `pnpm db:migrate` first. Use `pnpm db:generate` for new migrations and `pnpm db:migrate` to apply them. The image never migrates on start; `compose.yml` runs `drizzle-kit migrate`, then `rebrand.mjs` (`apps/web/scripts/rebrand.ts`, which re-encrypts secrets stored under the legacy key labels), as an `x-pre_deploy` hook.

## Gotchas

- Post-release: breaking changes are a big deal. No backfill, no backwards compatibility, data loss in migrations is NOT fine.
- Legacy-named key labels (like the Git webhook HKDF label) and identifiers from before the rename to Clowder are deliberate: Git hosts or existing clusters hold them. Don't rename them.
- Backend tests need Docker. Testcontainers starts one `postgres:18-alpine`, and `tests/setup.ts` overwrites `DATABASE_URL`, so the dev DB is never used.
- Env is managed by varlock: `.env.schema` in `apps/web` and `packages/db`. `postinstall` / `pnpm env:generate` regenerates `apps/web/src/generated-env.ts` and `packages/db/src/env.ts`. Edit the schema instead of those generated files. Packages read `APP_SECRET`, `APP_URL` and `DATABASE_URL` through `@clowder/config/env`, never `process.env` directly.
- drizzle-orm and drizzle-kit are v1 RCs pinned in the `pnpm-workspace.yaml` catalog. `db.query` is RQBv2: relations live in `packages/db/src/relations.ts` (`defineRelations`), and `where` takes objects, not callbacks. Migrations are one folder per migration (`<timestamp>_<name>/migration.sql`).
- Use `effect` only for effect-mq job and queue code in `packages/workflows` and the worker bootstrap. Don't add it elsewhere; existing `Match`/`Predicate` imports in `apps/web` and `packages/api` are legacy, not a pattern. It is pinned to `4.0.0-rc.116` (Effect v4, not v3 APIs).
- oRPC is v2 beta, so load the `orpc` skill instead of relying on v1 knowledge.
- Icons are Phosphor (`phosphor-svelte/lib/<Name>Icon`), bold by default from the root layout; see `DESIGN.md`. Importing from `phosphor-svelte` directly pulls in the whole set.
- `effect-mq` and `nuqs-svelte` are patched through `patches/`.
- The web and worker images bundle `uc` (`UNCLOUD_VERSION` and hashes in `apps/web/Dockerfile` and `apps/worker/Dockerfile`, checked by `tests/workflows/bundled-uc.test.ts`). Keep it in sync with `github.com/psviderski/uncloud` in `apps/sidecar/go.mod`: `ProvisionCluster` installs the daemon at the bundled CLI's version, `AddMachine` at the version the cluster runs. Never pass `--yes` to `uc machine init` unless the user confirmed a reset, nor to `uc machine add`: it wipes an already-initialised server.
- Lint includes custom `anti-slop` oxlint plugins (`tools/oxlint/anti-slop`), configured in the root `vite.config.ts`. They ban module mocking, object parameters, `unknown` params/returns, runtime `typeof`, chained or unexplained type assertions (they need a safety comment), `filter().map()`, and manual Effect `_tag` handling, among other things.
- Formatting uses 4 spaces, double quotes, and semicolons.

## Docs

- `DESIGN.md`: UI design contract. Reuse `apps/web/src/lib/components/ui` and follow the canvas resource panel and cluster detail page. Use the m3-svelte skill only if asked; this app uses shadcn-svelte components.
- Loading states in `apps/web` use the shared skullet-backed `Skeleton` component (`$lib/components/ui/skeleton`) for every placeholder. Keep page-level loading layouts full height when the loaded view fills the page.

## Things you have to always follow as a clanker

- use nuqs-svelte where possible instead of the usual $state, search params should be used godly.
- keep it simple, minimal and follow best practices.
- always use skullet (https://skullet.lochie.me) through the shared `Skeleton` for skeletons.
- the code should be readable by a human.
- do your research before a medium+ sized change.
- think like a senior engineer
- creating things (API keys, members, etc.) happens in a dialog, never in an inline card/form. Destructive confirmations use `alert-dialog` (see `settings/confirm-dialog.svelte`), never `confirm()`/`alert()`.
- stop fucking adding descriptions to frames.
