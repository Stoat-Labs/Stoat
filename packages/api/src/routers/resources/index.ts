import { appSecret } from "@stoat/config/env";
import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    clusterMonitoring,
    clusters,
    deployments,
    resources,
    resourceDeploymentInputs,
    s3Buckets,
    type DeploymentMetadata,
    type DeploymentStatus,
} from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import {
    GREPTIME_SERVICE,
    ALLOY_SERVICE,
    GREPTIME_USERNAME,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import {
    organizationProcedure,
    resourceMiddleware,
    resourceReadMiddleware,
    uncloudMiddleware,
} from "../..";
import {
    formatComposeFile,
    moveComposeEnvironment,
    resourceComposePrefix,
    resourceEnv,
} from "../../compose";
import { composeResourceTypes } from "../../databases";
import { lockedComposeResource, resourceEditInput, resourceGitRouter } from "./git";
import { resourceDiscardRouter } from "./discard";
import { resourceMetricsRouter } from "./metrics";
import { resourcePostgresRouter } from "./postgres";
import { assertProjectVisible, editableProject } from "./access";
import { resourceGroupsRouter } from "./groups";
import { resourceTransferRouter } from "./transfer";
import { gitText } from "../connections";
import { machineName } from "../cluster/initialization";
import { isMonitoringResource, resourceLogsRouter } from "./logs";

import { resourceDeployRouter } from "./deploy";
import { resourceMoveRouter } from "./move";
import { resourceMountsRouter } from "./mounts";
import { resourceGraphRouter } from "./graph";
import { resourceCreateRouter } from "./create";
import { resourceConnectionRouter } from "./connection";

// The Uncloud services a resource runs: the last ready deploy's, or the draft's before one.
async function resourceServiceNames(db: Database, resource: Resource) {
    const monitoring = await isMonitoringResource(db, resource.id);

    const snapshot = monitoring
        ? undefined
        : (await deployedSnapshots(db, [resource.id])).get(resource.id);

    return serviceNamesFor(resource, snapshot, monitoring);
}

type Resource = typeof resources.$inferSelect;

type DeployedSnapshot = { spec: string | null; prefix: string | null };

/** The latest successful deploy of each resource, which says what actually runs. */
async function deployedSnapshots(db: Database, resourceIds: string[]) {
    const rows = await db
        .selectDistinctOn([deployments.resourceId], {
            resourceId: deployments.resourceId,
            spec: deployments.spec,
            prefix: resourceDeploymentInputs.prefix,
        })
        .from(deployments)
        .leftJoin(
            resourceDeploymentInputs,
            eq(resourceDeploymentInputs.deploymentId, deployments.id),
        )
        .where(
            and(
                inArray(deployments.resourceId, resourceIds),
                eq(deployments.name, "DeployResource"),
                eq(deployments.status, "ready"),
            ),
        )
        .orderBy(deployments.resourceId, desc(deployments.finishedAt), desc(deployments.createdAt));

    return new Map<string, DeployedSnapshot>(
        rows.map(({ resourceId, ...row }) => [resourceId!, row]),
    );
}

/** The Uncloud service names a resource runs as. Throws for a deployed spec that no longer parses. */
function serviceNamesFor(
    resource: Resource,
    snapshot: DeployedSnapshot | undefined,
    monitoring: boolean,
) {
    if (monitoring) return [GREPTIME_SERVICE, ALLOY_SERVICE];

    if (!resource.spec && !resource.draftSpec) {
        throw new ORPCError("NOT_FOUND", { message: "Resource has no compose spec." });
    }

    const deployed = snapshot?.spec ?? (resource.spec?.trim() ? resource.spec : null);

    try {
        return formatComposeFile(
            deployed ?? resource.draftSpec!,
            snapshot?.prefix ?? resourceComposePrefix(resource),
        ).serviceNames;
    } catch (error) {
        // Before the first deploy the draft is only a guess at what runs, and an
        // unfinished one is not an error worth showing next to the editor.
        if (!deployed) return [];

        throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid compose spec.",
        });
    }
}

export const resourcesRouter = {
    ...resourceGitRouter,
    ...resourceTransferRouter,
    ...resourceGroupsRouter,
    ...resourceDiscardRouter,
    ...resourceMetricsRouter,
    ...resourceLogsRouter,
    ...resourcePostgresRouter,
    ...resourceDeployRouter,
    ...resourceMoveRouter,
    ...resourceMountsRouter,
    ...resourceGraphRouter,
    ...resourceCreateRouter,
    ...resourceConnectionRouter,
    updateComposeSpec: organizationProcedure
        .input(
            v.object({
                ...resourceEditInput,
                spec: gitText,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) =>
            db.transaction(async (tx) => {
                const locked = await lockedComposeResource(tx, input);

                // A Git source would put them back on the next sync, so its file stays as written.
                const { compose, env } = locked.gitSource
                    ? { compose: input.spec, env: resourceEnv(locked) }
                    : moveComposeEnvironment(input.spec, resourceEnv(locked));

                const [resource] = await tx
                    .update(resources)
                    .set({
                        draftSpec: compose,
                        settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${env}::text)`,
                    })
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return resource!;
            }),
        ),

    updateVariables: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                env: v.string(),
                // The Variables the edit started from; a save over someone else's change is refused.
                expectedEnv: v.optional(v.string()),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const scope = and(
                eq(resources.id, input.resourceId),
                eq(resources.projectId, input.projectId),
                inArray(resources.type, composeResourceTypes),
                sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
            );

            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${input.env}::text)`,
                })
                .where(
                    and(
                        scope,
                        input.expectedEnv === undefined
                            ? undefined
                            : sql`coalesce(${resources.settings}->>'env', '') = ${input.expectedEnv}`,
                    ),
                )
                .returning();

            if (!resource && input.expectedEnv !== undefined) {
                const [exists] = await db.select({ id: resources.id }).from(resources).where(scope);

                if (exists)
                    throw new ORPCError("CONFLICT", {
                        message:
                            "These Variables changed while you were editing. Copy your edits, reopen the editor and try again.",
                    });
            }

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateSettings: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                prefixNames: v.boolean(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('prefixNames', ${input.prefixNames}::boolean)`,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                        sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateDetails: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                icon: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000_000))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const description = input.description?.trim() ? input.description.trim() : null;
            const icon = input.icon?.trim() ? input.icon.trim() : null;

            const [resource] = await db
                .update(resources)
                .set({
                    name: input.name.trim(),
                    description,
                    icon,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                        sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    listResources: organizationProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await assertProjectVisible(db, organizationId, input.projectId);

            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    id: deployments.id,
                    status: deployments.status,
                    progress: deployments.progress,
                    createdAt: deployments.createdAt,
                    finishedAt: deployments.finishedAt,
                    source: sql<
                        DeploymentMetadata["source"] | null
                    >`${deployments.metadata}->>'source'`.as("source"),
                })
                .from(deployments)
                .innerJoin(resources, eq(deployments.resourceId, resources.id))
                .where(
                    and(
                        eq(deployments.name, "DeployResource"),
                        eq(resources.projectId, input.projectId),
                    ),
                )
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("latest");

            return db
                .select({
                    id: resources.id,
                    name: resources.name,
                    description: resources.description,
                    icon: resources.icon,
                    type: resources.type,
                    engine: sql<string | null>`${resources.settings}->>'engine'`,
                    projectId: resources.projectId,
                    groupId: resources.groupId,
                    gitBranch: sql<string | null>`${resources.gitSource}->>'branch'`,
                    createdAt: resources.createdAt,
                    updatedAt: resources.updatedAt,
                    deploymentId: latest.id,
                    deploymentStatus: sql<DeploymentStatus | null>`${latest.status}`,
                    deploymentProgress: latest.progress,
                    deploymentCreatedAt: latest.createdAt,
                    deploymentFinishedAt: latest.finishedAt,
                    deploymentSource: latest.source,
                    bucketStatus: s3Buckets.status,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                .leftJoin(s3Buckets, eq(s3Buckets.resourceId, resources.id))
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));
        }),

    getResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource } }) => {
            const [monitoring] = await db
                .select({
                    clusterId: clusterMonitoring.clusterId,
                    encryptedPassword: clusterMonitoring.encryptedPassword,
                    configuration: clusters.initializationConfiguration,
                    initializedAt: clusters.initializedAt,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    sidecarCertificate: clusters.sidecarCertificate,
                })
                .from(clusterMonitoring)
                .innerJoin(clusters, eq(clusters.id, clusterMonitoring.clusterId))
                .where(eq(clusterMonitoring.resourceId, resource.id))
                .limit(1);

            if (!monitoring) return resource;

            // Monitoring values are injected at deploy time and never stored as resource env.
            let password = "";

            try {
                password = decryptMonitoringPassword(
                    monitoring.encryptedPassword,
                    appSecret(),
                    monitoring.clusterId,
                );
            } catch {
                password = "";
            }

            const saved = monitoring.configuration?.machine ?? "";

            // Pre-rename configurations stored an ID; show its current name when reachable.
            const machine = await unwrap(
                ucClient(monitoring.sidecarUrl, {
                    token: monitoring.sidecarToken,
                    certificate: monitoring.sidecarCertificate,
                }).GET("/api/v1/machines", { signal: AbortSignal.timeout(5_000) }),
            ).then(
                ({ items }) => machineName(items, saved),
                () => saved,
            );

            const env = [
                ["GREPTIME_URL", `http://${GREPTIME_SERVICE}.internal:4006`],
                ["GREPTIME_DB", MONITORING_DATABASE],
                ["GREPTIME_USERNAME", GREPTIME_USERNAME],
                ["GREPTIME_PASSWORD", password],
                ["GREPTIME_MACHINE", machine],
                ["CLUSTER_ID", monitoring.clusterId],
                ["RETENTION_DAYS", String(monitoring.configuration?.retentionDays ?? "")],
            ]
                .map(([key, value]) => `${key}=${value}`)
                .join("\n");

            // The initialized stack is the deployed template; expose it so views treat it as deployed.
            return {
                ...resource,
                spec: monitoring.initializedAt ? resource.draftSpec : resource.spec,
                settings: { ...monitoring.configuration, machine, env: `${env}\n` },
            };
        }),
    getContainers: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource, uc } }) => {
            const serviceNames = await resourceServiceNames(db, resource);

            const containers = await Promise.all(
                serviceNames.map(async (id) => {
                    const result = await uc.GET("/api/v1/services/{id}", {
                        params: { path: { id } },
                    });

                    if (result.response.status === 404) return [];

                    const service = await unwrap(Promise.resolve(result));

                    return service.containers;
                }),
            );

            return containers.flat();
        }),

    // Containers of every resource in a project from one sidecar call, so the canvas polls once
    // instead of once per card. Keyed by resource id; a resource that does not parse has none.
    // Each container carries its Compose service name, so a collapsed stack can count its services.
    getProjectContainers: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, organizationId, uc }, input }) => {
            const project = await assertProjectVisible(db, organizationId, input.projectId);

            if (project.clusterId !== input.clusterId)
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            const list = await db
                .select()
                .from(resources)
                .where(
                    and(
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                    ),
                );

            if (list.length === 0) return {};

            const ids = list.map((resource) => resource.id);

            const [snapshots, monitoringRows, services] = await Promise.all([
                deployedSnapshots(db, ids),
                db
                    .select({ id: clusterMonitoring.resourceId })
                    .from(clusterMonitoring)
                    .where(inArray(clusterMonitoring.resourceId, ids)),
                unwrap(uc.GET("/api/v1/services")),
            ]);

            const monitoring = new Set(monitoringRows.map((row) => row.id));
            const byName = new Map(services.items.map((service) => [service.name, service]));

            return Object.fromEntries(
                list.map((resource) => {
                    let names: string[];

                    try {
                        names = serviceNamesFor(
                            resource,
                            snapshots.get(resource.id),
                            monitoring.has(resource.id),
                        );
                    } catch {
                        names = [];
                    }

                    // Uncloud knows services by their prefixed names; the canvas by Compose's.
                    const prefix =
                        snapshots.get(resource.id)?.prefix ?? resourceComposePrefix(resource);

                    return [
                        resource.id,
                        names.flatMap((name) =>
                            (byName.get(name)?.containers ?? []).map((item) => ({
                                ...item,
                                service:
                                    prefix && name.startsWith(`${prefix}-`)
                                        ? name.slice(prefix.length + 1)
                                        : name,
                            })),
                        ),
                    ];
                }),
            );
        }),

    // Stops or starts the resource's containers in place. Nothing records it, so the next deploy starts them again.
    setRunning: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                running: v.boolean(),
            }),
        )
        .use(uncloudMiddleware)
        .use(resourceMiddleware)
        .handler(async ({ context: { db, resource, uc }, input }) => {
            const serviceNames = await resourceServiceNames(db, resource);

            if (serviceNames.length === 0) {
                throw new ORPCError("BAD_REQUEST", { message: "Resource has no services to run." });
            }

            const path = input.running
                ? "/api/v1/services/{id}/start"
                : "/api/v1/services/{id}/stop";

            await Promise.all(
                serviceNames.map((id) => unwrap(uc.POST(path, { params: { path: { id } } }))),
            );
        }),
    getFormattedCompose: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(({ context: { resource } }) => {
            if (!resource.draftSpec) {
                throw new ORPCError("NOT_FOUND", { message: "Resource has no compose draft." });
            }

            const prefix = resourceComposePrefix(resource);

            try {
                const formatted = formatComposeFile(resource.draftSpec, prefix);

                return { ...formatted, prefix };
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", {
                    message: error instanceof Error ? error.message : "Invalid compose spec.",
                });
            }
        }),
};
