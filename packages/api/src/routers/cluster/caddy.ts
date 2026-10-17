import { ORPCError } from "@orpc/server";
import { clusters, deployments } from "@stoat/db/schema/index";
import { unwrap } from "@stoat/uncloud";
import { missingMetricsSubdirectives } from "@stoat/workflows/caddy-metrics";
import {
    CaddyDeploymentInProgressError,
    createCaddyDeployment,
} from "@stoat/workflows/deploy-caddy";
import { and, eq, inArray } from "drizzle-orm";
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
            const [settings, configs, [cluster], [active]] = await Promise.all([
                unwrap(uc.GET("/api/v1/caddy", { signal })),
                unwrap(uc.GET("/api/v1/caddy/configs", { signal })),
                db
                    .select({ initializedAt: clusters.initializedAt })
                    .from(clusters)
                    .where(eq(clusters.id, input.clusterId))
                    .limit(1),
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
                // Deploys add HTTP metrics only while monitoring runs.
                monitoring: !!cluster?.initializedAt,
                // A `metrics` option the user wrote is kept as is, so HTTP traffic needs these added.
                missingMetrics: missingMetricsSubdirectives(settings.caddyfile),
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
            const [cluster] = await db
                .select({ id: clusters.id, initializedAt: clusters.initializedAt })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            try {
                const deploymentId = await createCaddyDeployment(
                    db,
                    cluster.id,
                    input.image,
                    input.caddyfile,
                    // Metrics are pushed to the monitoring stack's Alloy, so they need it running.
                    !!cluster.initializedAt,
                );

                return { deploymentId };
            } catch (error) {
                if (error instanceof CaddyDeploymentInProgressError)
                    throw new ORPCError("CONFLICT", { message: error.message });

                throw error;
            }
        }),
};
