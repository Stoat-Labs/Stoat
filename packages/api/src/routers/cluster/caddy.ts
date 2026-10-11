import { ORPCError } from "@orpc/server";
import { clusters, deploymentLogs, deployments } from "@stoat/db/schema/index";
import { unwrap } from "@stoat/uncloud";
import { caddyComposeSpec } from "@stoat/workflows/deploy-caddy";
import { queueCaddyDeployment } from "@stoat/workflows/runtime";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import {
    isOrganizationAdmin,
    organizationAdminProcedure,
    organizationProcedure,
    uncloudMiddleware,
} from "../..";

const clusterInput = v.object({
    clusterId: v.pipe(v.string(), v.uuid()),
});

export const caddyRouter = {
    // Reads the live caddy service, so settings changed with `uc caddy deploy` show up here too.
    getCaddy: organizationProcedure
        .input(clusterInput)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc, organizationRole }, input, signal }) => {
            const [settings, configs, [active]] = await Promise.all([
                unwrap(uc.GET("/api/v1/caddy", { signal })),
                unwrap(uc.GET("/api/v1/caddy/configs", { signal })),
                db
                    .select({ id: deployments.id })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.clusterId, input.clusterId),
                            eq(deployments.name, "DeployCaddy"),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    )
                    .limit(1),
            ]);

            const canManage = isOrganizationAdmin(organizationRole);

            return {
                deployed: settings.deployed,
                image: settings.image,
                // Global configs are where inline DNS provider tokens end up.
                caddyfile: canManage ? settings.caddyfile : null,
                hasCaddyfile: settings.caddyfile !== "",
                // Caddy keeps serving its previous config on these machines.
                reconciliationErrors: configs.items.flatMap((item) =>
                    item.lastReconciliationError
                        ? [{ machine: item.machineName, error: item.lastReconciliationError }]
                        : [],
                ),
                activeDeploymentId: active?.id ?? null,
                canManage,
            };
        }),

    deployCaddy: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                image: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(512)),
                caddyfile: v.pipe(v.string(), v.maxLength(262_144)),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const deploymentId = await db.transaction(async (tx) => {
                // Locking the cluster row serializes rollouts, so two never race on the same service.
                const [cluster] = await tx
                    .select({ id: clusters.id })
                    .from(clusters)
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .for("update")
                    .limit(1);

                if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

                const [active] = await tx
                    .select({ id: deployments.id })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.clusterId, cluster.id),
                            eq(deployments.name, "DeployCaddy"),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    )
                    .limit(1);

                if (active)
                    throw new ORPCError("CONFLICT", {
                        message: "A Caddy deployment is already in progress on this cluster.",
                    });

                const id = randomUUID();

                await tx.insert(deployments).values({
                    id,
                    jobId: id,
                    clusterId: cluster.id,
                    name: "DeployCaddy",
                    status: "queued",
                    spec: caddyComposeSpec(input.image, input.caddyfile),
                });
                await tx.insert(deploymentLogs).values({
                    deploymentId: id,
                    text: "Caddy deployment queued.",
                    metadata: { level: "info" },
                });

                return id;
            });

            // The queued row is the outbox, so a failed enqueue is picked up by the next sweep.
            await queueCaddyDeployment(deploymentId).catch(() => {});

            return { deploymentId };
        }),
};
