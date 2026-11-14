import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import { deleteEmptyGroups } from "@clowder/db/groups";
import {
    clusters,
    deployments,
    projects,
    resourceGroups,
    resources,
} from "@clowder/db/schema/index";
import { resourceSlug } from "@clowder/db/slug";
import { referencedResourceIds } from "@clowder/workflows/references";
import { referenceResourceId, VARIABLE_REFERENCE } from "@clowder/workflows/variable-reference";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { resourceEnv } from "../../compose";
import { unpinVolumeNames } from "../../compose/move";
import { composeResourceTypes } from "../../databases";

type Executor = Pick<Database, "select">;

type Resource = typeof resources.$inferSelect;

const uuid = v.pipe(v.string(), v.uuid());

const transferInput = {
    projectId: uuid,
    resourceId: uuid,
    toProjectId: uuid,
};

const groupTransferInput = {
    projectId: uuid,
    groupId: uuid,
    toProjectId: uuid,
};

const copyName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

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

// Buckets own provider keys and are reconciled through their own flow.
function assertTransferable(resource: Resource) {
    if (!composeResourceTypes.some((type) => type === resource.type))
        throw new ORPCError("BAD_REQUEST", { message: "Buckets can't be moved or copied." });
}

async function lockedResource(db: Executor, projectId: string, resourceId: string) {
    const [resource] = await db
        .select()
        .from(resources)
        .where(and(eq(resources.id, resourceId), eq(resources.projectId, projectId)))
        .for("update");

    if (!resource) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

    assertTransferable(resource);

    return resource;
}

async function lockedGroup(db: Executor, projectId: string, groupId: string) {
    const lockMembers = () =>
        db
            .select()
            .from(resources)
            .where(and(eq(resources.groupId, groupId), eq(resources.projectId, projectId)))
            .orderBy(asc(resources.createdAt))
            .for("update");

    // Resources before their group, the order every membership change locks in, so none deadlock.
    await lockMembers();

    const [group] = await db
        .select()
        .from(resourceGroups)
        .where(and(eq(resourceGroups.id, groupId), eq(resourceGroups.projectId, projectId)))
        .for("update");

    if (!group) throw new ORPCError("NOT_FOUND", { message: "Group not found." });

    // Again under the group lock: a resource that joined while we waited for it comes along.
    const members = await lockMembers();

    members.forEach(assertTransferable);

    return { group, members };
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
 * `travelling` are the ids going along (the resource, or its whole group), which stay reachable.
 */
async function crossClusterIssue(
    db: Executor,
    clusterId: string,
    resource: Resource,
    travelling: string[],
    checkReaders: boolean,
) {
    if (referencedIds(resource).some((id) => !travelling.includes(id)))
        return `"${resource.name}" references other resources in its variables, and those only resolve on its current cluster.`;

    if (!checkReaders) return null;

    const others = await db
        .select({ name: resources.name, settings: resources.settings })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .where(and(eq(projects.clusterId, clusterId), notInArray(resources.id, travelling)));

    const reader = others.find((other) => referencedIds(other).includes(resource.id));

    return reader
        ? `"${reader.name}" references "${resource.name}", so it can't move to another cluster.`
        : null;
}

// Its services stay on the old cluster, and removal would only look on the new one.
async function assertNotDeployed(db: Executor, resourceIds: string[]) {
    if (!resourceIds.length) return;

    const [deployed] = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(inArray(deployments.resourceId, resourceIds))
        .limit(1);

    if (deployed)
        throw new ORPCError("CONFLICT", {
            message:
                "It has been deployed on its current cluster. Copy it to the other project instead.",
        });
}

// The configuration as a new draft, never volume data.
async function copyRow(
    db: Pick<Database, "insert">,
    id: string,
    resource: Resource,
    name: string,
    projectId: string,
    groupId: string | null,
    settings: Resource["settings"],
) {
    const spec = resource.draftSpec ?? resource.spec;
    const draftSpec = spec === null ? null : unpinVolumeNames(spec);

    // Deploying the copy would push its own volume names into the original's Git file.
    const keepsGit = draftSpec === spec;

    const [copy] = await db
        .insert(resources)
        .values({
            id,
            name,
            // Its own names on the cluster, so the copy never takes over the original.
            slug: resourceSlug(name),
            description: resource.description,
            icon: resource.icon,
            type: resource.type,
            draftSpec,
            settings,
            gitConnectionId: keepsGit ? resource.gitConnectionId : null,
            gitSource: keepsGit ? resource.gitSource : null,
            projectId,
            groupId,
        })
        .returning();

    return copy!;
}

/** Points `{{ <id>.KEY }}` at the copies, so a copied group reads its own members. */
function remapReferences(settings: Resource["settings"], copies: Map<string, string>) {
    const env = resourceEnv({ settings });

    if (!env) return settings;

    // `resourceEnv` only returns text when settings is an object, so the rest is kept as is.
    return Object.assign({}, settings, {
        env: env.replaceAll(VARIABLE_REFERENCE, (reference, id: string, key: string) => {
            const copy = copies.get(referenceResourceId(id) ?? "");

            return copy ? `{{ ${copy}.${key} }}` : reference;
        }),
    });
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
                    await assertNotDeployed(tx, [resource.id]);

                    const issue = await crossClusterIssue(
                        tx,
                        from.clusterId,
                        resource,
                        [resource.id],
                        true,
                    );

                    if (issue) throw new ORPCError("CONFLICT", { message: issue });
                }

                // Groups belong to a project, so it arrives ungrouped.
                const [moved] = await tx
                    .update(resources)
                    .set({ projectId: to.id, groupId: null })
                    .where(eq(resources.id, resource.id))
                    .returning();

                await deleteEmptyGroups(tx, [from.id]);

                return moved!;
            }),
        ),

    // Railway's Duplicate, into any project: the configuration as a new draft, never volume data.
    copyResource: organizationProcedure
        .input(v.object({ ...transferInput, name: copyName }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const from = await editableProject(tx, organizationId, input.projectId);
                const to = await editableProject(tx, organizationId, input.toProjectId);
                const resource = await lockedResource(tx, input.projectId, input.resourceId);

                const issue =
                    from.clusterId === to.clusterId
                        ? null
                        : await crossClusterIssue(
                              tx,
                              from.clusterId,
                              resource,
                              [resource.id],
                              false,
                          );

                if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });

                return copyRow(
                    tx,
                    randomUUID(),
                    resource,
                    input.name,
                    to.id,
                    null,
                    resource.settings,
                );
            }),
        ),

    // The group and everything in it, as they are; references between them keep resolving.
    moveGroup: organizationProcedure
        .input(v.object(groupTransferInput))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                if (input.toProjectId === input.projectId)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "The group is already in that project.",
                    });

                const from = await editableProject(tx, organizationId, input.projectId);
                const to = await editableProject(tx, organizationId, input.toProjectId);
                const { group, members } = await lockedGroup(tx, input.projectId, input.groupId);
                const ids = members.map((member) => member.id);

                if (from.clusterId !== to.clusterId) {
                    await assertNotDeployed(tx, ids);

                    for (const member of members) {
                        const issue = await crossClusterIssue(
                            tx,
                            from.clusterId,
                            member,
                            ids,
                            true,
                        );

                        if (issue) throw new ORPCError("CONFLICT", { message: issue });
                    }
                }

                const [moved] = await tx
                    .update(resourceGroups)
                    .set({ projectId: to.id })
                    .where(eq(resourceGroups.id, group.id))
                    .returning();

                if (ids.length)
                    await tx
                        .update(resources)
                        .set({ projectId: to.id })
                        .where(inArray(resources.id, ids));

                return moved!;
            }),
        ),

    // Duplicate for a whole group: a new group of copies that reference each other.
    copyGroup: organizationProcedure
        .input(v.object({ ...groupTransferInput, name: copyName }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const from = await editableProject(tx, organizationId, input.projectId);
                const to = await editableProject(tx, organizationId, input.toProjectId);
                const { group, members } = await lockedGroup(tx, input.projectId, input.groupId);
                const ids = members.map((member) => member.id);

                if (from.clusterId !== to.clusterId)
                    for (const member of members) {
                        const issue = await crossClusterIssue(
                            tx,
                            from.clusterId,
                            member,
                            ids,
                            false,
                        );

                        if (issue) throw new ORPCError("BAD_REQUEST", { message: issue });
                    }

                const [copy] = await tx
                    .insert(resourceGroups)
                    .values({
                        id: randomUUID(),
                        projectId: to.id,
                        name: input.name,
                        icon: group.icon,
                    })
                    .returning();

                // Ids first, so each copy's references can point at its siblings' copies.
                const copies = new Map(members.map((member) => [member.id, randomUUID()]));

                for (const member of members) {
                    await copyRow(
                        tx,
                        copies.get(member.id)!,
                        member,
                        member.name,
                        to.id,
                        copy!.id,
                        remapReferences(member.settings, copies),
                    );
                }

                return copy!;
            }),
        ),
};
