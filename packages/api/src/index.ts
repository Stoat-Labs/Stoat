import { ORPCError, os } from "@orpc/server";

import { getOrganizationMembership } from "@stoat/db/organizations";
import { clusters, projects, resources } from "@stoat/db/schema/index";
import { ucClient } from "@stoat/uncloud";
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

export const protectedProcedure = publicProcedure.use(requireAuth);

export const organizationProcedure = publicProcedure.use(async ({ context, next }) => {
    const { session } = context;

    // Organization API keys act with admin rights inside their organization.
    if (context.apiKey) {
        return next({
            context: { organizationId: context.apiKey.organizationId, organizationRole: "admin" },
        });
    }

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

    return next({ context: { organizationId, organizationRole: membership.role } });
});

export const organizationAdminProcedure = organizationProcedure.use(async ({ context, next }) => {
    if (
        !context.organizationRole
            .split(",")
            .some((role) => role.trim() === "owner" || role.trim() === "admin")
    ) {
        throw new ORPCError("FORBIDDEN", {
            message: "This action requires an organization owner or admin.",
        });
    }

    return next();
});

export function isOrganizationAdmin(role: string) {
    return role.split(",").some((part) => {
        const value = part.trim();

        return value === "owner" || value === "admin";
    });
}

export const uncloudMiddleware = organizationProcedure.middleware(
    async ({ context: { db, organizationId }, next }, input: { clusterId: string }) => {
        const [cluster] = await db
            .select({
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
            })
            .from(clusters)
            .where(
                and(eq(clusters.id, input.clusterId), eq(clusters.organizationId, organizationId)),
            )
            .limit(1);

        if (!cluster) {
            throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
        }

        return next({
            context: {
                uc: ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken }),
            },
        });
    },
);

// System-managed internal projects are readable by owners/admins only and never writable here.
function resourceAccess(allowInternalRead: boolean) {
    return organizationProcedure.middleware(
        async (
            { context: { db, organizationId, organizationRole }, next },
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
                        allowInternalRead && isOrganizationAdmin(organizationRole)
                            ? undefined
                            : sql`${projects.isInternal} is not true`,
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
