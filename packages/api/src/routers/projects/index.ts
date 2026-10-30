import { ORPCError } from "@orpc/server";
import {
    clusters,
    deployments,
    projectFavorites,
    projects,
    resources,
    s3Buckets,
    type CanvasLayout,
    type DeploymentStatus,
    type S3BucketStatus,
} from "@stoat/db/schema/index";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { isOrganizationAdmin, organizationAdminProcedure, organizationProcedure } from "../..";
import { composeServices, templateMatcher } from "../../project-graph";
import { templates } from "../../templates";
import { removeResources } from "../../resources/removal";

/** The first service's image, or null for an empty or unreadable spec. */
/** Served by apps/web/src/routes/resource-icons; the version changes with the icon. */
function resourceIconUrl(resourceId: string, version: string) {
    return `/resource-icons/${resourceId}?v=${version}`;
}

// Overviews refetch every minute per open tab and specs rarely change, so parse each one once.
const firstImages = new Map<string, string | null>();

function firstImage(compose: string | null) {
    if (!compose?.trim()) return null;

    const cached = firstImages.get(compose);

    if (cached !== undefined) return cached;

    let image: string | null;

    try {
        image = composeServices(compose)[0]?.image ?? null;
    } catch {
        image = null;
    }

    // Bounded: drop the oldest entry once full, which keeps the hot specs in practice.
    if (firstImages.size >= 1000) firstImages.delete(firstImages.keys().next().value!);

    firstImages.set(compose, image);

    return image;
}

/** A bucket's reconcile state, as the deployment state the project card counts. */
const bucketDeploymentStatus: Record<S3BucketStatus, DeploymentStatus> = {
    provisioning: "running",
    deleting: "running",
    ready: "ready",
    failed: "failed",
};

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
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
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
                    canvasLayout: projects.canvasLayout,
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

            // Read with the row itself: a separate cache would serve another replica's stale
            // layout for its whole TTL and saves nothing over this primary-key lookup.
            const { clusterName, canvasLayout: storedLayout, ...project } = row;
            const canvasLayout: CanvasLayout = storedLayout ?? {};

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
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()), favorite: v.boolean() }))
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
        async ({ context: { apiKey, db, organizationId, session } }) => {
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

            const projectIds = rows.map((row) => row.id);

            // Scoped to these projects' resources, so it reads a few index entries instead of
            // every deployment of every organization.
            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    status: deployments.status,
                    createdAt: deployments.createdAt,
                })
                .from(deployments)
                .where(
                    and(
                        eq(deployments.name, "DeployResource"),
                        inArray(
                            deployments.resourceId,
                            db
                                .select({ id: resources.id })
                                .from(resources)
                                .where(inArray(resources.projectId, projectIds)),
                        ),
                    ),
                )
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("latest");

            const resourceRows = await db
                .select({
                    id: resources.id,
                    name: resources.name,
                    projectId: resources.projectId,
                    // Uploaded icons are data URLs of up to a megabyte each. Browsers load them
                    // from a cacheable URL instead; API keys keep the inline value.
                    icon: apiKey
                        ? resources.icon
                        : sql<
                              string | null
                          >`case when ${resources.icon} like 'data:%' then null else ${resources.icon} end`,
                    iconVersion: sql<
                        string | null
                    >`case when ${resources.icon} like 'data:%' then left(md5(${resources.icon}), 12) end`,
                    type: resources.type,
                    spec: resources.spec,
                    draftSpec: resources.draftSpec,
                    updatedAt: resources.updatedAt,
                    status: latest.status,
                    deployedAt: latest.createdAt,
                    bucketStatus: s3Buckets.status,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                // Buckets are reconciled, not deployed, so their state lives here.
                .leftJoin(s3Buckets, eq(s3Buckets.resourceId, resources.id))
                .where(inArray(resources.projectId, projectIds))
                .orderBy(asc(resources.createdAt));

            const resourcesByProject = Map.groupBy(resourceRows, (row) => row.projectId);

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
                const items = resourcesByProject.get(project.id) ?? [];

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
                            icon:
                                item.icon ??
                                (item.iconVersion
                                    ? resourceIconUrl(item.id, item.iconVersion)
                                    : null),
                            type: item.type,
                            image,
                            // Logos are large, so the client looks this app id up in the template list.
                            template: templateFor(image),
                            status: item.bucketStatus
                                ? bucketDeploymentStatus[item.bucketStatus]
                                : // SAFETY: `latest.status` is `deployments.status`, a DeploymentStatus
                                  // column; the subquery alias only widens its type to string.
                                  ((item.status ?? null) as DeploymentStatus | null),
                        };
                    }),
                };
            });
        },
    ),

    createProject: organizationProcedure
        .input(
            v.object({
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                clusterId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id, provisioning: clusters.provisioning })
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

            if (cluster.provisioning)
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: "This cluster is still being set up.",
                });

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
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
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
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                layout: v.record(
                    v.pipe(v.string(), v.maxLength(100)),
                    v.object({ x: v.number(), y: v.number() }),
                ),
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

            return project;
        }),

    // Removes every resource's services from the cluster, then the project. Buckets go first,
    // through their own flow, so their provider keys are revoked.
    deleteProject: organizationAdminProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
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

                return { id: project.id };
            }),
        ),
};
