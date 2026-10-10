import { ORPCError } from "@orpc/server";
import { cache, currentWindow, swr } from "@stoat/cache";
import type { Database } from "@stoat/db";
import {
    cancelDeployment as cancelDeploymentRow,
    deleteSettledDeployment,
    getDeploymentWithLogs,
    listDeployments,
    watchDeployment,
    watchDeploymentChanges,
} from "@stoat/db/deployments";
import { clusters, deployments, projects, resources } from "@stoat/db/schema/index";
import { cancelDeploymentJob } from "@stoat/workflows/runtime";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as v from "valibot";
import { organizationAdminProcedure, organizationProcedure } from "../..";
import { cancellableStream } from "../../stream";

function canInitializeRole(role: string) {
    return role.split(",").some((part) => part.trim() === "owner" || part.trim() === "admin");
}

function isTerminalStatus(status: string) {
    return status === "ready" || status === "failed" || status === "cancelled";
}

async function requireOrgCluster(db: Database, organizationId: string, clusterId: string) {
    const [cluster] = await db
        .select({ id: clusters.id })
        .from(clusters)
        .where(and(eq(clusters.id, clusterId), eq(clusters.organizationId, organizationId)))
        .limit(1);

    if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

    return cluster;
}

export const deploymentsRouter = {
    streamDeployment: organizationProcedure
        .input(
            v.object({
                deploymentId: v.pipe(v.string(), v.uuid()),
                afterId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            }),
        )
        .handler(({ context: { db, organizationId, organizationRole }, input, signal }) =>
            cancellableStream(async function* (signal) {
                const [deployment] = await db
                    .select({ clusterId: deployments.clusterId })
                    .from(deployments)
                    .where(eq(deployments.id, input.deploymentId));

                if (!deployment)
                    throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });

                await requireOrgCluster(db, organizationId, deployment.clusterId);

                for await (const event of watchDeployment(db, input.deploymentId, {
                    afterId: input.afterId,
                    signal,
                })) {
                    yield { ...event, canCancel: canInitializeRole(organizationRole) };
                }
            }, signal),
        ),

    watchDeployments: organizationProcedure.handler(({ context: { db, organizationId }, signal }) =>
        cancellableStream(async function* (signal) {
            for await (const change of watchDeploymentChanges(db, { signal, includeLogs: false })) {
                if (change.clusterId === null) {
                    yield { deploymentId: null };
                    continue;
                }

                const [cluster] = await db
                    .select({ id: clusters.id })
                    .from(clusters)
                    .where(
                        and(
                            eq(clusters.id, change.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    );

                if (cluster) yield { deploymentId: change.deploymentId };
            }
        }, signal),
    ),

    listDeployments: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const cluster = await requireOrgCluster(db, organizationId, input.clusterId);

            return listDeployments(db, cluster.id, input.limit ?? 20);
        }),

    getDeployment: organizationProcedure
        .input(v.object({ deploymentId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const key = `deployment:${input.deploymentId}`;

            // Terminal deployments are immutable, so a cached copy stays valid.
            // canCancel depends on the caller's role and is recomputed per request.

            const cached =
                await cache.getItem<Awaited<ReturnType<typeof getDeploymentWithLogs>>>(key);

            if (cached && isTerminalStatus(cached.status)) {
                await requireOrgCluster(db, organizationId, cached.clusterId);

                return { ...cached, canCancel: canInitializeRole(organizationRole) };
            }

            const deployment = await getDeploymentWithLogs(db, input.deploymentId);

            if (!deployment) throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
            await requireOrgCluster(db, organizationId, deployment.clusterId);

            if (isTerminalStatus(deployment.status)) await cache.setItem(key, deployment);

            return { ...deployment, canCancel: canInitializeRole(organizationRole) };
        }),

    cancelDeployment: organizationAdminProcedure
        .input(v.object({ deploymentId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const deployment = await getDeploymentWithLogs(db, input.deploymentId);

            if (!deployment) throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
            await requireOrgCluster(db, organizationId, deployment.clusterId);
            // Freeze first so a concurrent worker cannot overwrite cancellation.
            const cancelled = await cancelDeploymentRow(db, deployment.id);

            if (!cancelled) {
                throw new ORPCError("CONFLICT", { message: "This deployment already settled." });
            }

            await cancelDeploymentJob(
                deployment.jobId,
                deployment.resourceId ? "DeployResource" : "InitializeCluster",
            );

            if (!deployment.resourceId)
                await db
                    .update(clusters)
                    .set({
                        initializationStatus: "failed",
                        initializationError: "Initialization was cancelled.",
                    })
                    .where(
                        and(
                            eq(clusters.id, deployment.clusterId),
                            isNull(clusters.initializedAt),
                            inArray(clusters.initializationStatus, [
                                "queued",
                                "running",
                                "retrying",
                            ]),
                        ),
                    );

            return { id: cancelled.id, status: "cancelled" as const };
        }),

    deleteDeployment: organizationAdminProcedure
        .input(v.object({ deploymentId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [deployment] = await db
                .select({ clusterId: deployments.clusterId })
                .from(deployments)
                .where(eq(deployments.id, input.deploymentId));

            if (!deployment) throw new ORPCError("NOT_FOUND", { message: "Deployment not found." });
            await requireOrgCluster(db, organizationId, deployment.clusterId);

            const deleted = await deleteSettledDeployment(db, input.deploymentId);

            if (!deleted) {
                throw new ORPCError("CONFLICT", {
                    message: "Cancel this deployment before deleting it.",
                });
            }

            await cache.removeItem(`deployment:${input.deploymentId}`);

            return { id: deleted.id };
        }),

    listAllDeployments: organizationProcedure
        .input(
            v.optional(
                v.object({
                    status: v.optional(
                        v.picklist(["queued", "running", "ready", "failed", "cancelled"]),
                    ),
                    limit: v.optional(
                        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
                    ),
                    offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
                    resourceId: v.optional(v.pipe(v.string(), v.uuid())),
                    projectId: v.optional(v.pipe(v.string(), v.uuid())),
                }),
            ),
        )
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const limit = input?.limit ?? 25;
            const offset = input?.offset ?? 0;
            const status = input?.status ?? "all";
            const resourceId = input?.resourceId ?? "";
            const projectId = input?.projectId ?? "";

            // New deployments expire the 15s window on their own; no manual bust needed.
            const page = await swr(
                `deployments:list:${organizationId}:${status}:${limit}:${offset}:${resourceId}:${projectId}`,
                currentWindow(),
                async () => {
                    const where = and(
                        eq(clusters.organizationId, organizationId),
                        input?.status ? eq(deployments.status, input.status) : undefined,
                        input?.resourceId
                            ? eq(deployments.resourceId, input.resourceId)
                            : undefined,
                        input?.projectId ? eq(resources.projectId, input.projectId) : undefined,
                    );

                    const items = await db
                        .select({
                            id: deployments.id,
                            clusterId: deployments.clusterId,
                            clusterName: clusters.name,
                            name: deployments.name,
                            status: deployments.status,
                            spec: deployments.spec,
                            createdAt: deployments.createdAt,
                            updatedAt: deployments.updatedAt,
                            finishedAt: deployments.finishedAt,
                            resourceId: deployments.resourceId,
                            resourceName: resources.name,
                            projectId: projects.id,
                            projectName: projects.name,
                        })
                        .from(deployments)
                        .innerJoin(clusters, eq(deployments.clusterId, clusters.id))
                        .leftJoin(resources, eq(deployments.resourceId, resources.id))
                        .leftJoin(projects, eq(resources.projectId, projects.id))
                        .where(where)
                        .orderBy(desc(deployments.createdAt))
                        .limit(limit)
                        .offset(offset);

                    const [row] = await db
                        .select({ count: sql<number>`count(*)::int` })
                        .from(deployments)
                        .innerJoin(clusters, eq(deployments.clusterId, clusters.id))
                        .leftJoin(resources, eq(deployments.resourceId, resources.id))
                        .where(where);

                    return { items, total: row?.count ?? 0 };
                },
            );

            // The cached page is shared by the whole org, so the role is attached per request.
            return { ...page, canDelete: canInitializeRole(organizationRole) };
        }),
};
