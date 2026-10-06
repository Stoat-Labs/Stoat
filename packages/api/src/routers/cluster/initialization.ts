import { ORPCError } from "@orpc/server";
import { createDeployment } from "@stoat/db/deployments";
import { clusterMonitoring, clusters, resources } from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import {
    GREPTIME_SERVICE,
    GREPTIME_USERNAME,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { sql } from "@stoat/workflows/greptime";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, eq, inArray } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import * as v from "valibot";
import { organizationAdminProcedure, organizationProcedure, uncloudMiddleware } from "../..";

const clusterInput = v.object({ clusterId: v.pipe(v.string(), v.uuid()) });

/** Saved configurations may predate names and still hold a machine ID; show the name. */
export function machineName(machines: { id: string; name: string }[], nameOrId: string) {
    return machines.find((machine) => machine.id === nameOrId)?.name ?? nameOrId;
}

const storageInput = v.pipe(
    v.object({
        type: v.picklist(["volume", "bind"]),
        source: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240)),
    }),
    v.check(
        ({ type, source }) =>
            type === "volume"
                ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(source)
                : /^\/(?:srv|mnt|data|opt|var\/lib)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(
                      source,
                  ) &&
                  !source.split("/").some((part) => part === ".." || part === ".") &&
                  !/^\/var\/lib\/(?:docker|containerd)(?:\/|$)/.test(source),
        "Use a valid volume name or a dedicated absolute data path under /srv, /mnt, /data, /opt, or /var/lib.",
    ),
);

export const DEFAULT_GREPTIME_VOLUME = "stoat-monitoring-greptime";

export const DEFAULT_ALLOY_VOLUME = "stoat-monitoring-alloy";

export const initializationConfigurationInput = v.pipe(
    v.object({
        machine: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        greptimeStorage: v.optional(storageInput),
        alloyStorage: v.optional(storageInput),
        retentionDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
    }),
    v.check(
        (config) =>
            (config.greptimeStorage?.source ?? DEFAULT_GREPTIME_VOLUME) !==
            (config.alloyStorage?.source ?? DEFAULT_ALLOY_VOLUME),
        "Greptime and Alloy must use separate storage locations.",
    ),
);

export const initializationRouter = {
    getInitializationOptions: organizationAdminProcedure
        .input(clusterInput)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc, organizationId }, input }) => {
            const [cluster] = await db
                .select({ configuration: clusters.initializationConfiguration })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const machines = await unwrap(
                uc.GET("/api/v1/machines", {
                    params: { query: { available: true } },
                    signal: AbortSignal.timeout(15_000),
                }),
            );

            const configuration = cluster?.configuration ?? null;

            return {
                machines: machines.items.map(({ name, state }) => ({ name, state })),
                configuration: configuration && {
                    ...configuration,
                    machine: machineName(machines.items, configuration.machine),
                },
            };
        }),
    initializeCluster: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                configuration: initializationConfigurationInput,
            }),
        )
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc, organizationId }, input }) => {
            const machines = await unwrap(
                uc.GET("/api/v1/machines", {
                    params: { query: { available: true } },
                    signal: AbortSignal.timeout(15_000),
                }),
            );

            if (!machines.items.some((machine) => machine.name === input.configuration.machine)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose an available machine from this cluster.",
                });
            }

            // The saved request is the durable outbox: committing it is sufficient even
            // if the worker or its queue connection is temporarily unavailable.
            const requestedAt = new Date();

            return db.transaction(async (tx) => {
                const [cluster] = await tx
                    .update(clusters)
                    .set({
                        initializationConfiguration: input.configuration,
                        initializationRequestedAt: requestedAt,
                        initializationStatus: "queued",
                        initializationError: null,
                    })
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                            eq(clusters.initializationStatus, "uninitialized"),
                        ),
                    )
                    .returning({ id: clusters.id });

                if (!cluster)
                    throw new ORPCError("CONFLICT", {
                        message:
                            "Initialization was already requested. Retry the existing initialization instead.",
                    });

                // Every request gets its own deployment row so the cluster page can
                // show history with per-attempt logs.
                const deployment = await createDeployment(tx, {
                    clusterId: cluster.id,
                    name: "InitializeCluster",
                    jobId: `${cluster.id}:${requestedAt.toISOString()}`,
                    configuration: input.configuration,
                });

                return {
                    id: cluster.id,
                    initializationStatus: "queued" as const,
                    deploymentId: deployment.id,
                };
            });
        }),
    retryInitialization: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                configuration: v.optional(initializationConfigurationInput),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const { configuration } = input;

            if (configuration) {
                // The sidecar client stays a handler local: putting UcClient
                // into the procedure context would push the whole app router
                // past the compiler's maximum serialized type length (TS7056).
                const [cluster] = await db
                    .select({
                        sidecarUrl: clusters.sidecarUrl,
                        sidecarToken: clusters.sidecarToken,
                    })
                    .from(clusters)
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .limit(1);

                if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

                const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });

                const machines = await unwrap(
                    uc.GET("/api/v1/machines", {
                        params: { query: { available: true } },
                        signal: AbortSignal.timeout(15_000),
                    }),
                );

                if (!machines.items.some((machine) => machine.name === configuration.machine)) {
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Choose an available machine from this cluster.",
                    });
                }
            }

            const requestedAt = new Date();

            return db.transaction(async (tx) => {
                const update: PgUpdateSetSource<typeof clusters> = {
                    initializationRequestedAt: requestedAt,
                    initializationStatus: "queued",
                    initializationError: null,
                    // A ready cluster being re-run must look uninitialized to
                    // the worker outbox (which only picks up NULL
                    // initializedAt) until this attempt succeeds again.
                    initializedAt: null,
                };

                if (configuration) update.initializationConfiguration = configuration;

                const [cluster] = await tx
                    .update(clusters)
                    .set(update)
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                            inArray(clusters.initializationStatus, ["failed", "ready"]),
                        ),
                    )
                    .returning({
                        id: clusters.id,
                        configuration: clusters.initializationConfiguration,
                    });

                if (!cluster || !cluster.configuration)
                    throw new ORPCError("CONFLICT", {
                        message:
                            "Only failed or ready initialization can be re-run, and a saved configuration is required when no new one is provided.",
                    });

                // Keep the internal monitoring snapshot aligned with a replaced
                // configuration. The worker redeploys from the cluster row, so
                // this is display state only.
                if (configuration) {
                    const [monitoring] = await tx
                        .select({ resourceId: clusterMonitoring.resourceId })
                        .from(clusterMonitoring)
                        .where(eq(clusterMonitoring.clusterId, cluster.id))
                        .limit(1);

                    if (monitoring) {
                        await tx
                            .update(resources)
                            .set({ settings: configuration, updatedAt: new Date() })
                            .where(eq(resources.id, monitoring.resourceId));
                    }
                }

                const deployment = await createDeployment(tx, {
                    clusterId: cluster.id,
                    name: "InitializeCluster",
                    jobId: `${cluster.id}:${requestedAt.toISOString()}`,
                    configuration: cluster.configuration,
                });

                return {
                    id: cluster.id,
                    initializationStatus: "queued" as const,
                    deploymentId: deployment.id,
                };
            });
        }),
    updateRetention: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                retentionDays: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({
                    id: clusters.id,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    configuration: clusters.initializationConfiguration,
                })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            const [monitoring] = await db
                .select({
                    resourceId: clusterMonitoring.resourceId,
                    encryptedPassword: clusterMonitoring.encryptedPassword,
                })
                .from(clusterMonitoring)
                .where(eq(clusterMonitoring.clusterId, cluster.id))
                .limit(1);

            if (!monitoring || !cluster.configuration)
                throw new ORPCError("CONFLICT", {
                    message: "Initialize monitoring before changing retention.",
                });

            if (cluster.configuration.retentionDays === input.retentionDays)
                return { retentionDays: input.retentionDays };

            const secret = process.env.APP_SECRET;

            let password: string | null = null;

            if (secret) {
                try {
                    password = decryptMonitoringPassword(
                        monitoring.encryptedPassword,
                        secret,
                        cluster.id,
                    );
                } catch {
                    password = null;
                }
            }

            if (!password)
                throw new ORPCError("CONFLICT", {
                    message:
                        "Stored monitoring credentials are unreadable. Re-run initialization to issue fresh ones.",
                });

            const uc = ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken });

            try {
                const greptime = await unwrap(
                    uc.GET("/api/v1/services/{id}", {
                        params: { path: { id: GREPTIME_SERVICE } },
                        signal: AbortSignal.timeout(30_000),
                    }),
                );

                await sql(
                    uc,
                    greptime,
                    password,
                    `ALTER DATABASE ${MONITORING_DATABASE} SET 'ttl'='${input.retentionDays}d'`,
                    AbortSignal.timeout(60_000),
                );
            } catch {
                throw new ORPCError("INTERNAL", {
                    message: "Could not reach GreptimeDB. Check sidecar connectivity and retry.",
                });
            }

            const configuration = { ...cluster.configuration, retentionDays: input.retentionDays };

            await db.transaction(async (tx) => {
                await tx
                    .update(clusters)
                    .set({ initializationConfiguration: configuration })
                    .where(eq(clusters.id, cluster.id));

                await tx
                    .update(resources)
                    .set({ settings: configuration, updatedAt: new Date() })
                    .where(eq(resources.id, monitoring.resourceId));
            });

            return { retentionDays: input.retentionDays };
        }),
};

const monitoringFallbackHttpUrl = "http://stoat-monitoring-greptimedb.internal:4000";

/** Dashboard/SQL endpoint derived from the stored ingest URL (same host, port 4000). */
function dashboardUrlFor(ingestUrl: string | null) {
    if (!ingestUrl) return monitoringFallbackHttpUrl;

    try {
        const url = new URL(ingestUrl);
        url.port = "4000";
        url.pathname = "";
        url.search = "";

        return url.toString().replace(/\/$/, "");
    } catch {
        return monitoringFallbackHttpUrl;
    }
}

export const monitoringRouter = {
    getMonitoringConnection: organizationProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id, greptimeUrl: clusters.greptimeUrl })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            const [monitoring] = await db
                .select()
                .from(clusterMonitoring)
                .where(eq(clusterMonitoring.clusterId, cluster.id))
                .limit(1);

            if (!monitoring) return { configured: false as const };

            const isAdmin = organizationRole
                .split(",")
                .some((part) => part.trim() === "owner" || part.trim() === "admin");

            // The password only ever leaves the server for owners/admins. A null
            // password for an admin means the app secret rotated since issuance;
            // re-running initialization issues fresh credentials.
            let password: string | null = null;

            if (isAdmin) {
                const secret = process.env.APP_SECRET;

                if (secret) {
                    try {
                        password = decryptMonitoringPassword(
                            monitoring.encryptedPassword,
                            secret,
                            cluster.id,
                        );
                    } catch {
                        password = null;
                    }
                }
            }

            return {
                configured: true as const,
                database: MONITORING_DATABASE,
                username: GREPTIME_USERNAME,
                ingestUrl:
                    cluster.greptimeUrl ?? "http://stoat-monitoring-greptimedb.internal:4006",
                httpUrl: dashboardUrlFor(cluster.greptimeUrl),
                password,
                canReveal: isAdmin,
            };
        }),
};
