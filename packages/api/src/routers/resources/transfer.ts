import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { clusters, deployments, projects, resources } from "@stoat/db/schema/index";
import { resourceSlug } from "@stoat/db/slug";
import { referencedResourceIds } from "@stoat/workflows/references";
import { and, eq, ne, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { resourceEnv } from "../../compose";
import { unpinVolumeNames } from "../../compose-move";
import { composeResourceTypes } from "../../databases";

type Executor = Pick<Database, "select">;

type Resource = typeof resources.$inferSelect;

const uuid = v.pipe(v.string(), v.uuid());

const transferInput = {
    projectId: uuid,
    resourceId: uuid,
    toProjectId: uuid,
};

async function editableProject(db: Executor, organizationId: string, projectId: string) {
    const [project] = await db
        .select({ id: projects.id, clusterId: projects.clusterId })
        .from(projects)
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                eq(projects.id, projectId),
                sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        )
        .limit(1);

    if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

    return project;
}

async function lockedResource(db: Executor, projectId: string, resourceId: string) {
    const [resource] = await db
        .select()
        .from(resources)
        .where(and(eq(resources.id, resourceId), eq(resources.projectId, projectId)))
        .for("update");

    if (!resource) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

    // Buckets own provider keys and are reconciled through their own flow.
    if (!composeResourceTypes.some((type) => type === resource.type))
        throw new ORPCError("BAD_REQUEST", { message: "Buckets can't be moved or copied." });

    return resource;
}

// An unreadable `.env` references nothing; the Variables page reports it.
function referencedIds(resource: Pick<Resource, "settings">) {
    try {
        return referencedResourceIds(resourceEnv(resource));
    } catch {
        return [];
    }
}

/**
 * Why `${{resource.VAR}}` references would break on another cluster, since they only resolve
 * between resources of one cluster: what the resource reads and, for a move, who reads it.
 */
async function crossClusterIssue(
    db: Executor,
    clusterId: string,
    resource: Resource,
    checkReaders: boolean,
) {
    if (referencedIds(resource).some((id) => id !== resource.id))
        return `"${resource.name}" references other resources in its variables, and those only resolve on its current cluster.`;

    if (!checkReaders) return null;

    const others = await db
        .select({ name: resources.name, settings: resources.settings })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .where(and(eq(projects.clusterId, clusterId), ne(resources.id, resource.id)));

    const reader = others.find((other) => referencedIds(other).includes(resource.id));

    return reader
        ? `"${reader.name}" references "${resource.name}", so it can't move to another cluster.`
        : null;
}

export const resourceTransferRouter = {
    // Its names come from its slug, never its project, so it keeps running as it is.
    moveResource: organizationProcedure
        .input(v.object(transferInput))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                if (input.toProjectId === input.projectId)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "The resource is already in that project.",
                    });

                const from = await editableProject(tx, organizationId, input.projectId);
                const to = await editableProject(tx, organizationId, input.toProjectId);
                const resource = await lockedResource(tx, input.projectId, input.resourceId);

                if (from.clusterId !== to.clusterId) {
                    // Its services stay on the old cluster, and removal would only look on the new one.
                    const [deployed] = await tx
                        .select({ id: deployments.id })
                        .from(deployments)
                        .where(eq(deployments.resourceId, resource.id))
                        .limit(1);

                    if (deployed)
                        throw new ORPCError("CONFLICT", {
                            message:
                                "It has been deployed on its current cluster. Copy it to the other project instead.",
                        });

                    const issue = await crossClusterIssue(tx, from.clusterId, resource, true);

                    if (issue) throw new ORPCError("CONFLICT", { message: issue });
                }

                const [moved] = await tx
                    .update(resources)
                    .set({ projectId: to.id })
                    .where(eq(resources.id, resource.id))
                    .returning();

                return moved!;
            }),
        ),

    // Railway's Duplicate, into any project: the configuration as a new draft, never volume data.
    copyResource: organizationProcedure
        .input(
            v.object({
                ...transferInput,
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const from = await editableProject(tx, organizationId, input.projectId);
                const to = await editableProject(tx, organizationId, input.toProjectId);
                const resource = await lockedResource(tx, input.projectId, input.resourceId);

                const issue =
                    from.clusterId === to.clusterId
                        ? null
                        : await crossClusterIssue(tx, from.clusterId, resource, false);

                if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });

                const spec = resource.draftSpec ?? resource.spec;

                const [copy] = await tx
                    .insert(resources)
                    .values({
                        id: randomUUID(),
                        name: input.name,
                        // Its own names on the cluster, so the copy never takes over the original.
                        slug: resourceSlug(input.name),
                        description: resource.description,
                        icon: resource.icon,
                        type: resource.type,
                        draftSpec: spec === null ? null : unpinVolumeNames(spec),
                        settings: resource.settings,
                        gitConnectionId: resource.gitConnectionId,
                        gitSource: resource.gitSource,
                        projectId: to.id,
                    })
                    .returning();

                return copy!;
            }),
        ),
};
