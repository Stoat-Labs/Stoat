import { ORPCError, os } from "@orpc/server";

import { getOrganizationMembership } from "@clowder/db/organizations";
import { clusters, projects, resources } from "@clowder/db/schema/index";
import { ucClient } from "@clowder/uncloud";
import { and, eq, sql } from "drizzle-orm";

import type { Context } from "./context";

export const o = os.$context<Context>();

export const publicProcedure = o;

export const requireAuth = o.middleware(async ({ context, next }) => {
    if (!context.session?.user) {
        throw new ORPCError("UNAUTHORIZED", {
            message: context.apiKey ? "This action requires a signed-in user." : undefined,
        });
    }

    return next({
        context: {
            session: context.session,
        },
    });
});

export const organizationProcedure = publicProcedure.use(async ({ context, next }) => {
    const { session } = context;

    if (context.apiKey) return next({ context: { organizationId: context.apiKey.organizationId } });

    if (!session?.user) {
        throw new ORPCError("UNAUTHORIZED");
    }

    const organizationId = session.session.activeOrganizationId;

    const membership = organizationId
        ? await getOrganizationMembership(context.db, session.user.id, organizationId)
        : null;

    if (!organizationId || !membership) {
        throw new ORPCError("FORBIDDEN", { message: "Select an organization you belong to." });
    }

    return next({ context: { organizationId } });
});

export const uncloudMiddleware = organizationProcedure.middleware(
    async ({ context: { db, organizationId }, next }, input: { clusterId: string }) => {
        const [cluster] = await db
            .select({
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
                sidecarCertificate: clusters.sidecarCertificate,
                provisioning: clusters.provisioning,
            })
            .from(clusters)
            .where(
                and(eq(clusters.id, input.clusterId), eq(clusters.organizationId, organizationId)),
            )
            .limit(1);

        if (!cluster) {
            throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
        }

        // Its sidecar doesn't exist until setup finishes.
        if (cluster.provisioning)
            throw new ORPCError("PRECONDITION_FAILED", {
                message: "This cluster is still being set up.",
            });

        return next({
            context: {
                uc: ucClient(cluster.sidecarUrl, {
                    token: cluster.sidecarToken,
                    certificate: cluster.sidecarCertificate,
                }),
            },
        });
    },
);

// System-managed internal projects are readable but never writable here.
function resourceAccess(allowInternalRead: boolean) {
    return organizationProcedure.middleware(
        async (
            { context: { db, organizationId }, next },
            input: { projectId: string; resourceId: string; clusterId?: string },
        ) => {
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        input.clusterId === undefined
                            ? undefined
                            : eq(projects.clusterId, input.clusterId),
                        allowInternalRead ? undefined : sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            const [resource] = await db
                .select()
                .from(resources)
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                    ),
                )
                .limit(1);

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Resource not found." });
            }

            return next({ context: { resource } });
        },
    );
}

export const resourceMiddleware = resourceAccess(false);

export const resourceReadMiddleware = resourceAccess(true);
