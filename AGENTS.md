# Stoat

No vendor lock-in PaaS dashboard on top of Uncloud. pnpm monorepo, driven by **vite-plus (`vp`)**, not plain vite/vitest/eslint/prettier.

## Layout

- `apps/web`: SvelteKit app (adapter-node). Serves the oRPC API at `src/routes/rpc/[...rest]` and starts the effect-mq worker from `hooks.server.ts` (never during build).
- `apps/sidecar`: Go HTTP API wrapping Uncloud; runs as root on cluster machines. `cmd/openapi` emits its OpenAPI spec.
- `packages/api`: oRPC routers and business logic. Packages export `src/*.ts` directly; `dist/` is only `tsc -b` output.
- `packages/db`: Drizzle schema and queries. Migrations live in `packages/db/src/migrations` and **also include** `packages/workflows/src/schema.ts` (effect-mq tables).
- `packages/workflows`: effect-mq jobs (`InitializeCluster`, `DeployResource`, `ReconcileBucket`). `internal/monitoring/compose.yaml` is the monitoring stack it deploys.
- `packages/s3`: S3 providers (Generic, RustFS, R2) and the AWS SDK client behind `/s3` connections and `bucket` resources. `src/providers/index.ts` is the client-safe catalog; the other provider files are server-only.
- `packages/uncloud`: TS client for the sidecar. `openapi.json` and `src/generated/` are committed artifacts.
- `tests/`: all TS tests live here (`api`, `uncloud`, `workflows`, `web`), not beside the source. Go tests stay in `apps/sidecar`.

## Commands

- `pnpm check`: lint, then `vp fmt --write`. `pnpm check-types`: `tsc -b` / `svelte-check` in every package.
- `pnpm test`: runs two separate configs, root `vite.config.ts` (api/uncloud/workflows) and `apps/web/vite.config.ts` (tests/web).
- Single test: `pnpm exec vp test run tests/api/git.test.ts`. For web tests: `pnpm --dir apps/web exec vp test run ../../tests/web/<file>.test.ts`.
- Go: `go -C apps/sidecar test ./...`.
- After changing sidecar routes or schemas: `pnpm uc:refresh` (needs Go) and commit both `openapi.json` and the generated types.
- DB: `pnpm db:start` (Postgres on host port **5435**), then `pnpm db:generate` for new migrations and `pnpm db:migrate` to apply them. Docker deploys do not run migrations.

## Gotchas

- Pre-release: breaking changes are NOT a big deal. No backfill, no backwards compatibility, data loss in migrations is fine. Prefer the clean schema over preserving unreleased data.
- Backend tests need Docker. Testcontainers starts one `postgres:18-alpine`, and `tests/setup.ts` overwrites `DATABASE_URL`, so the dev DB is never used.
- Env is managed by varlock: `.env.schema` in `apps/web` and `packages/db`. `postinstall` / `pnpm env:generate` regenerates `apps/web/src/generated-env.ts` and `packages/db/src/env.ts`. Edit the schema instead of those generated files.
- Two drizzle-orm versions coexist: 0.45.2 for the app and a v1 RC for effect-mq in `@stoat/workflows`. Keep the `pnpm-workspace.yaml` overrides and `ssr.noExternal: ["drizzle-orm"]` in `apps/web/vite.config.ts`, or the runtime crashes.
- Use `effect` only for effect-mq job and queue code in `packages/workflows` and the worker bootstrap. Don't add it elsewhere; existing `Match`/`Predicate` imports in `apps/web` and `packages/api` are legacy, not a pattern. It is pinned to `4.0.0-rc.116` (Effect v4, not v3 APIs).
- oRPC is v2 beta, so load the `orpc` skill instead of relying on v1 knowledge.
- `effect-mq` and `nuqs-svelte` are patched through `patches/`.
- Lint includes custom `anti-slop` oxlint plugins (`tools/oxlint/anti-slop`), configured in the root `vite.config.ts`. They ban module mocking, object parameters, `unknown` params/returns, runtime `typeof`, chained or unexplained type assertions (they need a safety comment), `filter().map()`, and manual Effect `_tag` handling, among other things.
- Formatting uses 4 spaces, double quotes, and semicolons.

## Docs

- `DESIGN.MD`: UI design contract. Reuse `apps/web/src/lib/components/ui` and follow the resource overview and Variables pages. Use the m3-svelte skill only if asked; this app uses shadcn-svelte components.
- Loading states in `apps/web` use the shared Phantom UI-backed `Skeleton` component for every placeholder. Keep page-level loading layouts full height when the loaded view fills the page.
- `REVIEW.md`: known open issues (security, races, stale artifacts). Check it before touching auth, cluster lifecycle, or workflows.

## Things you have to always follow as a clanker

- use nuqs-svelte where possible instead of the usual $state, search params should be used godly.
- keep it simple, minimal and follow best practices.
- always use phantomui for skeletons.
- the code should be readable by a human.
- do your research before a medium+ sized change.
- think like a senior engineer
- creating things (API keys, members, etc.) happens in a dialog, never in an inline card/form. Destructive confirmations use `alert-dialog` (see `settings/confirm-dialog.svelte`), never `confirm()`/`alert()`.
