import { ORPCError } from "@orpc/server";
import { cache } from "@stoat/cache";
import {
    clusters,
    deployments,
    projectFavorites,
    projects,
    resources,
    type CanvasLayout,
    type DeploymentStatus,
} from "@stoat/db/schema/index";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isOrganizationAdmin, organizationAdminProcedure, organizationProcedure } from "../..";
import { composeServices, templateMatcher } from "../../project-graph";
import { templates } from "../../templates";
import { removeResources } from "../../resource-removal";

function canvasLayoutKey(projectId: string) {
    return `canvas-layout:${projectId}`;
}

/** The first service's image, or null for an empty or unreadable spec. */
function firstImage(compose: string | null) {
    if (!compose?.trim()) return null;

    try {
        return composeServices(compose)[0]?.image ?? null;
    } catch {
        return null;
    }
}

export const projectsRouter = {
    listProjects: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select({
                id: projects.id,
                name: projects.name,
                description: projects.description,
                clusterId: projects.clusterId,
                createdAt: projects.createdAt,
                updatedAt: projects.updatedAt,
                resourceCount: sql<number>`count(${resources.id})::int`,
            })
            .from(projects)
            .innerJoin(clusters, eq(projects.clusterId, clusters.id))
            .leftJoin(resources, eq(resources.projectId, projects.id))
            .where(
                and(
                    eq(clusters.organizationId, organizationId),
                    sql`${projects.isInternal} is not true`,
                ),
            )
            .groupBy(
                projects.id,
                projects.name,
                projects.description,
                projects.clusterId,
                projects.createdAt,
                projects.updatedAt,
            )
            .orderBy(asc(projects.createdAt)),
    ),

    getProject: organizationProcedure
        .input(z.object({ projectId: z.string().uuid() }))
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            const [row] = await db
                .select({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                    clusterId: projects.clusterId,
                    clusterName: clusters.name,
                    createdAt: projects.createdAt,
                    updatedAt: projects.updatedAt,
                    isInternal: projects.isInternal,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!row || (row.isInternal && !isOrganizationAdmin(organizationRole)))
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            const { clusterName, ...project } = row;

            // Layout saves are frequent and reads happen on every canvas visit, so the jsonb
            // column is only read on a cache miss.
            const key = canvasLayoutKey(project.id);
            let canvasLayout = await cache.getItem<CanvasLayout>(key);

            if (!canvasLayout) {
                const [stored] = await db
                    .select({ layout: projects.canvasLayout })
                    .from(projects)
                    .where(eq(projects.id, project.id));

                canvasLayout = stored?.layout ?? {};
                await cache.setItem(key, canvasLayout);
            }

            // Derived so existing clusters and cluster renames need no data migration.
            return project.isInternal
                ? {
                      ...project,
                      canvasLayout,
                      clusterName,
                      isInternal: true,
                      name: `${clusterName}-internal`,
                  }
                : { ...project, canvasLayout, clusterName, isInternal: false };
        }),

    setFavorite: organizationProcedure
        .input(z.object({ projectId: z.string().uuid(), favorite: z.boolean() }))
        .handler(async ({ context: { db, organizationId, session }, input }) => {
            if (!session?.user)
                throw new ORPCError("UNAUTHORIZED", {
                    message: "Favorites belong to a signed-in user.",
                });

            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            if (input.favorite)
                await db
                    .insert(projectFavorites)
                    .values({ userId: session.user.id, projectId: project.id })
                    .onConflictDoNothing();
            else
                await db
                    .delete(projectFavorites)
                    .where(
                        and(
                            eq(projectFavorites.userId, session.user.id),
                            eq(projectFavorites.projectId, project.id),
                        ),
                    );

            return input;
        }),

    listProjectOverviews: organizationProcedure.handler(
        async ({ context: { db, organizationId, session } }) => {
            const rows = await db
                .select({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                    clusterId: projects.clusterId,
                    clusterName: clusters.name,
                    createdAt: projects.createdAt,
                    updatedAt: projects.updatedAt,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(clusters.organizationId, organizationId),
                        sql`${projects.isInternal} is not true`,
                    ),
                )
                .orderBy(asc(projects.createdAt));

            if (rows.length === 0) return [];

            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    status: deployments.status,
                    createdAt: deployments.createdAt,
                })
                .from(deployments)
                .where(eq(deployments.name, "DeployResource"))
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("latest");

            const resourceRows = await db
                .select({
                    id: resources.id,
                    name: resources.name,
                    projectId: resources.projectId,
                    icon: resources.icon,
                    type: resources.type,
                    spec: resources.spec,
                    draftSpec: resources.draftSpec,
                    updatedAt: resources.updatedAt,
                    status: latest.status,
                    deployedAt: latest.createdAt,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                .where(
                    inArray(
                        resources.projectId,
                        rows.map((row) => row.id),
                    ),
                )
                .orderBy(asc(resources.createdAt));

            // API keys have no user, so nothing is starred for them.
            const favorites = new Set(
                session?.user
                    ? (
                          await db
                              .select({ projectId: projectFavorites.projectId })
                              .from(projectFavorites)
                              .where(eq(projectFavorites.userId, session.user.id))
                      ).map((row) => row.projectId)
                    : [],
            );

            const templateFor = templateMatcher(templates);

            return rows.map((project) => {
                const items = resourceRows.filter((row) => row.projectId === project.id);

                const activity = items.reduce(
                    (value, item) =>
                        Math.max(value, item.updatedAt.getTime(), item.deployedAt?.getTime() ?? 0),
                    project.updatedAt.getTime(),
                );

                return {
                    ...project,
                    favorite: favorites.has(project.id),
                    lastActivityAt: new Date(activity),
                    resources: items.map((item) => {
                        // Specs stay server-side; the card only needs what its tile shows.
                        const image = firstImage(item.draftSpec ?? item.spec);

                        return {
                            id: item.id,
                            name: item.name,
                            icon: item.icon,
                            type: item.type,
                            image,
                            // Logos are large, so the client looks this app id up in the template list.
                            template: templateFor(image),
                            status: (item.status ?? null) as DeploymentStatus | null,
                        };
                    }),
                };
            });
        },
    ),

    createProject: organizationProcedure
        .input(
            z.object({
                name: z.string().trim().min(1).max(100),
                description: z.string().trim().max(500).optional(),
                clusterId: z.string().uuid(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) {
                throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });
            }

            const description = input.description?.trim() ? input.description.trim() : null;

            const [project] = await db
                .insert(projects)
                .values({
                    id: randomUUID(),
                    name: input.name.trim(),
                    description,
                    clusterId: cluster.id,
                })
                .returning({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                    clusterId: projects.clusterId,
                    createdAt: projects.createdAt,
                    updatedAt: projects.updatedAt,
                });

            return { ...project, resourceCount: 0 };
        }),

    updateProject: organizationProcedure
        .input(
            z.object({
                projectId: z.string().uuid(),
                name: z.string().trim().min(1).max(100),
                description: z.string().trim().max(500).optional(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .update(projects)
                .set({ name: input.name, description: input.description || null })
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        inArray(
                            projects.clusterId,
                            db
                                .select({ id: clusters.id })
                                .from(clusters)
                                .where(eq(clusters.organizationId, organizationId)),
                        ),
                    ),
                )
                .returning({
                    id: projects.id,
                    name: projects.name,
                    description: projects.description,
                });

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            return project;
        }),
    setCanvasLayout: organizationProcedure
        .input(
            z.object({
                projectId: z.string().uuid(),
                layout: z.record(z.string().max(100), z.object({ x: z.number(), y: z.number() })),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .update(projects)
                .set({
                    canvasLayout: input.layout,
                    // Dragging a card is not project activity.
                    updatedAt: sql`${projects.updatedAt}`,
                })
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        inArray(
                            projects.clusterId,
                            db
                                .select({ id: clusters.id })
                                .from(clusters)
                                .where(eq(clusters.organizationId, organizationId)),
                        ),
                    ),
                )
                .returning({ id: projects.id });

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            // Written through after the database, so the next read never sees an older layout.
            await cache.setItem(canvasLayoutKey(project.id), input.layout);

            return project;
        }),

    // Removes every resource's services from the cluster, then the project. Buckets go first,
    // through their own flow, so their provider keys are revoked.
    deleteProject: organizationAdminProcedure
        .input(z.object({ projectId: z.string().uuid() }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [project] = await tx
                    .select({ id: projects.id, clusterId: projects.clusterId })
                    .from(projects)
                    .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                    .where(
                        and(
                            eq(projects.id, input.projectId),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .for("update", { of: projects });

                if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

                const owned = await tx
                    .select()
                    .from(resources)
                    .where(eq(resources.projectId, project.id))
                    .for("update");

                await removeResources(tx, project.clusterId, owned);
                await tx.delete(projects).where(eq(projects.id, project.id));
                await cache.removeItem(canvasLayoutKey(project.id));

                return { id: project.id };
            }),
        ),
};
