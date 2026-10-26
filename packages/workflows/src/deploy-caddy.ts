import type { Database } from "@stoat/db";
import { appendDeploymentLog, getDeploymentByJobId } from "@stoat/db/deployments";
import { ucClient, unwrap, type UcClient } from "@stoat/uncloud";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Effect, Predicate } from "effect";
import { Document, parse } from "yaml";
import { withCaddyMetrics } from "./caddy-metrics";
import { DeploymentError, followDeployment } from "./deploy-compose";
import { DeployCaddy } from "./jobs";
import { ALLOY_SERVICE } from "./monitoring-compose";
import { JobStoreLive } from "./store";

export const CADDY_FAILURE_MESSAGE =
    "Caddy deployment failed. Check the image and sidecar connectivity, then retry.";

export type CaddySettings = { image: string; caddyfile: string; env?: Record<string, string> };

export class CaddyDeploymentInProgressError extends Error {
    constructor() {
        super("A Caddy deployment is already in progress on this cluster.");
    }
}

/**
 * Caddy pushes its metrics over OTLP to Alloy, which remote-writes them to GreptimeDB like every
 * other metric. `nearest.` prefers the Alloy on Caddy's own machine, and Alloy labels each series
 * with the sending Caddy's address, so two Caddys never share a series.
 */
export const CADDY_METRICS_ENV = {
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://nearest.${ALLOY_SERVICE}.internal:4318/v1/metrics`,
    OTEL_SERVICE_NAME: "caddy",
    OTEL_METRIC_EXPORT_INTERVAL: "15000",
};

/**
 * The deployment's `spec` snapshot: the caddy service as a Compose file, with the global
 * Caddyfile under `x-caddy` like Uncloud's own Compose format.
 */
export function caddyComposeSpec(
    image: string,
    caddyfile: string,
    env?: Record<string, string>,
): string {
    const caddy = {
        image,
        ...(env && { environment: env }),
        ...(caddyfile.trim() && { "x-caddy": `${caddyfile.trim()}\n` }),
    };

    return new Document({ services: { caddy } }).toString();
}

export function parseCaddyComposeSpec(spec: string): CaddySettings {
    const compose: unknown = parse(spec);

    const caddy =
        Predicate.isObject(compose) && Predicate.isObject(compose.services)
            ? compose.services.caddy
            : undefined;

    if (!Predicate.isObject(caddy) || !Predicate.isString(caddy.image))
        throw new Error("The Caddy deployment spec has no image.");

    const environment = Predicate.isObject(caddy.environment) ? caddy.environment : undefined;

    return {
        image: caddy.image,
        caddyfile: Predicate.isString(caddy["x-caddy"]) ? caddy["x-caddy"] : "",
        ...(environment && {
            env: Object.fromEntries(
                Object.entries(environment).flatMap(([key, value]) =>
                    Predicate.isString(value) ? [[key, value]] : [],
                ),
            ),
        }),
    };
}

/**
 * Queues a DeployCaddy rollout. With monitoring, Caddy also gets per-host HTTP metrics pushed to
 * Alloy.
 */
export async function createCaddyDeployment(
    db: Database,
    clusterId: string,
    image: string,
    caddyfile: string,
    monitoring: boolean,
): Promise<string> {
    const spec = monitoring
        ? caddyComposeSpec(image, withCaddyMetrics(caddyfile), CADDY_METRICS_ENV)
        : caddyComposeSpec(image, caddyfile);

    const id = randomUUID();
    const client = await db.$client.connect();

    try {
        await client.query("BEGIN");
        // Locking the cluster row serializes rollouts, so two never race on the same service.
        await client.query("SELECT id FROM clusters WHERE id = $1 FOR UPDATE", [clusterId]);

        const active = await client.query(
            `SELECT id FROM deployments
             WHERE cluster_id = $1 AND name = 'DeployCaddy' AND status IN ('queued', 'running') LIMIT 1`,
            [clusterId],
        );

        if (active.rowCount) throw new CaddyDeploymentInProgressError();

        await client.query(
            `INSERT INTO deployments (id, job_id, cluster_id, name, status, spec, created_at, updated_at)
             VALUES ($1, $2, $3, 'DeployCaddy', 'queued', $4, now(), now())`,
            [id, id, clusterId, spec],
        );
        await client.query(
            `INSERT INTO deployment_logs (deployment_id, text, metadata, created_at)
             VALUES ($1, 'Caddy deployment queued.', '{"level":"info"}'::jsonb, now())`,
            [id],
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        throw error;
    } finally {
        client.release();
    }

    // The queued row is the outbox, so a failed enqueue is picked up by the next sweep.
    await queueCaddyDeployment(id).catch(() => {});

    return id;
}

async function queueCaddyDeployment(deploymentId: string): Promise<void> {
    await Effect.runPromise(
        DeployCaddy.enqueue({ deploymentId }).pipe(Effect.provide(JobStoreLive)),
    );
}

/**
 * Once monitoring is up, rolls Caddy out again with its current image and global Caddyfile so it
 * starts pushing HTTP metrics. Monitoring works without them, so failures are only logged.
 */
export async function enableCaddyMetrics(
    db: Database,
    uc: UcClient,
    clusterId: string,
    log: (text: string) => Promise<void>,
    signal: AbortSignal,
): Promise<void> {
    try {
        const caddy = await unwrap(uc.GET("/api/v1/caddy", { signal }));

        if (!caddy.deployed) {
            await log("Caddy is not deployed; it collects HTTP metrics once deployed from Stoat.");

            return;
        }

        await createCaddyDeployment(db, clusterId, caddy.image, caddy.caddyfile, true);
        await log("Redeploying Caddy to collect HTTP metrics.");
    } catch (error) {
        // Never fail initialization over this, not even on a timeout.
        await log(
            error instanceof CaddyDeploymentInProgressError
                ? "A Caddy deployment is in progress; save the Caddy settings again afterwards to collect HTTP metrics."
                : "Could not redeploy Caddy for HTTP metrics; save the Caddy settings to retry.",
        );
    }
}

export async function deployCaddy(db: Database, deploymentId: string, signal: AbortSignal) {
    const log = (text: string, level: "info" | "debug" | "error" = "info", event = "step") =>
        appendDeploymentLog(db, deploymentId, text, { level, event });

    try {
        signal.throwIfAborted();
        const deployment = await getDeploymentByJobId(db, deploymentId);

        if (
            !deployment ||
            deployment.name !== "DeployCaddy" ||
            !deployment.spec ||
            !["queued", "running"].includes(deployment.status)
        )
            return;

        const claimed = await db.$client.query(
            `UPDATE deployments SET status = 'running', progress = 0, error = NULL, finished_at = NULL, updated_at = now()
             WHERE id = $1 AND status IN ('queued', 'running') RETURNING id`,
            [deploymentId],
        );

        if (!claimed.rowCount) return;

        const cluster = await db.query.clusters.findFirst({
            columns: { sidecarUrl: true, sidecarToken: true },
            where: (cluster, { eq }) => eq(cluster.id, deployment.clusterId),
        });

        if (!cluster) throw new Error("Cluster not found.");

        const settings = parseCaddyComposeSpec(deployment.spec);
        const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });

        await log(`Deploying Caddy ${settings.image} to every machine.`);

        await followDeployment(
            uc.stream.deployCaddy(settings, { signal }),
            signal,
            log,
            undefined,
            async (percent) => {
                await db.$client.query(
                    "UPDATE deployments SET progress = $2 WHERE id = $1 AND status = 'running' AND progress < $2",
                    [deploymentId, percent],
                );
            },
        );

        // An invalid global Caddyfile does not fail the rollout: each machine keeps serving its
        // previous config. Give the daemons a moment to regenerate, then surface any rejection.
        await setTimeout(5_000, undefined, { signal });

        const configs = await unwrap(uc.GET("/api/v1/caddy/configs", { signal })).catch(() => null);

        for (const item of configs?.items ?? []) {
            if (item.lastReconciliationError)
                await log(
                    `${item.machineName} rejected the generated Caddy config and keeps serving its previous one: ${item.lastReconciliationError}`,
                    "error",
                    "caddy-config",
                );
        }

        await db.$client.query(
            `WITH ready AS (
                UPDATE deployments SET status = 'ready', progress = 100, error = NULL, finished_at = now(), updated_at = now()
                WHERE id = $1 AND status = 'running' RETURNING id
            )
            INSERT INTO deployment_logs (deployment_id, text, metadata, created_at)
            SELECT $1, 'Caddy is deployed.', '{"level":"info","event":"ready"}'::jsonb, now()
            FROM ready`,
            [deploymentId],
        );
    } catch (error) {
        if (!signal.aborted) {
            const reason = error instanceof DeploymentError ? error.message : CADDY_FAILURE_MESSAGE;

            // followDeployment already logs its own failures.
            if (!(error instanceof DeploymentError))
                await log(reason, "error", "attempt-failed").catch(() => {});
            await db.$client
                .query(
                    "UPDATE deployments SET error = $2, updated_at = now() WHERE id = $1 AND status IN ('queued', 'running')",
                    [deploymentId, reason],
                )
                .catch(() => {});
        }

        throw new Error(CADDY_FAILURE_MESSAGE);
    }
}
