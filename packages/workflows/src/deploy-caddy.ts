import type { Database } from "@stoat/db";
import { appendDeploymentLog, getDeploymentByJobId } from "@stoat/db/deployments";
import { ucClient, unwrap } from "@stoat/uncloud";
import { setTimeout } from "node:timers/promises";
import { Predicate } from "effect";
import { Document, parse } from "yaml";
import { DeploymentError, followDeployment } from "./deploy-compose";

export const CADDY_FAILURE_MESSAGE =
    "Caddy deployment failed. Check the image and sidecar connectivity, then retry.";

export type CaddySettings = { image: string; caddyfile: string };

/**
 * The deployment's `spec` snapshot: the caddy service as a Compose file, with the global
 * Caddyfile under `x-caddy` like Uncloud's own Compose format.
 */
export function caddyComposeSpec(image: string, caddyfile: string): string {
    const caddy = caddyfile.trim() ? { image, "x-caddy": `${caddyfile.trim()}\n` } : { image };

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

    return {
        image: caddy.image,
        caddyfile: Predicate.isString(caddy["x-caddy"]) ? caddy["x-caddy"] : "",
    };
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
