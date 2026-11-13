import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { deleteEmptyGroups } from "@clowder/db/groups";
import { resourceGroups, resources } from "@clowder/db/schema/index";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { assertProjectVisible, editableProject } from "./access";

const uuid = v.pipe(v.string(), v.uuid());

const groupDetails = {
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    icon: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000_000))),
};

// Railway's groups: canvas frames around whole resources. Each resource keeps its own
// Compose file and deploys on its own; a group only draws them together.
export const resourceGroupsRouter = {
    listGroups: organizationProcedure
        .input(v.object({ projectId: uuid }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await assertProjectVisible(db, organizationId, input.projectId);

            return db
                .select({
                    id: resourceGroups.id,
                    projectId: resourceGroups.projectId,
                    name: resourceGroups.name,
                    icon: resourceGroups.icon,
                })
                .from(resourceGroups)
                .where(eq(resourceGroups.projectId, input.projectId))
                .orderBy(asc(resourceGroups.createdAt));
        }),

    // Railway's "Group › New Group": a group always starts with the resources put in it.
    createGroup: organizationProcedure
        .input(
            v.object({
                projectId: uuid,
                ...groupDetails,
                resourceIds: v.pipe(v.array(uuid), v.minLength(1)),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [project] = await editableProject(tx, organizationId, input.projectId);

                if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

                const [group] = await tx
                    .insert(resourceGroups)
                    .values({
                        id: randomUUID(),
                        projectId: project.id,
                        name: input.name,
                        icon: input.icon || null,
                    })
                    .returning();

                const ids = [...new Set(input.resourceIds)];

                const moved = await tx
                    .update(resources)
                    .set({ groupId: group!.id })
                    .where(and(inArray(resources.id, ids), eq(resources.projectId, project.id)))
                    .returning({ id: resources.id });

                if (moved.length !== ids.length)
                    throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                await deleteEmptyGroups(tx, [project.id]);

                return group!;
            }),
        ),

    // Like `updateDetails`, it replaces both fields, so the caller sends the one it keeps.
    updateGroup: organizationProcedure
        .input(v.object({ projectId: uuid, groupId: uuid, ...groupDetails }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [group] = await db
                .update(resourceGroups)
                .set({ name: input.name, icon: input.icon || null })
                .where(
                    and(
                        eq(resourceGroups.id, input.groupId),
                        eq(resourceGroups.projectId, input.projectId),
                        sql`${resourceGroups.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
                    ),
                )
                .returning();

            if (!group) throw new ORPCError("NOT_FOUND", { message: "Group not found." });

            return group;
        }),

    // Railway's "Remove Group": the frame goes, its resources stay where they are.
    deleteGroup: organizationProcedure
        .input(v.object({ projectId: uuid, groupId: uuid }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [group] = await db
                .delete(resourceGroups)
                .where(
                    and(
                        eq(resourceGroups.id, input.groupId),
                        eq(resourceGroups.projectId, input.projectId),
                        sql`${resourceGroups.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
                    ),
                )
                .returning({ id: resourceGroups.id });

            if (!group) throw new ORPCError("NOT_FOUND", { message: "Group not found." });
        }),

    // Into another group of the same project, or out of any (null).
    setGroup: organizationProcedure
        .input(v.object({ projectId: uuid, resourceId: uuid, groupId: v.nullable(uuid) }))
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [resource] = await tx
                    .update(resources)
                    .set({ groupId: input.groupId })
                    .where(
                        and(
                            eq(resources.id, input.resourceId),
                            eq(resources.projectId, input.projectId),
                            sql`${resources.projectId} in (${editableProject(tx, organizationId, input.projectId)})`,
                            input.groupId === null
                                ? undefined
                                : sql`exists (${tx
                                      .select({ id: resourceGroups.id })
                                      .from(resourceGroups)
                                      .where(
                                          and(
                                              eq(resourceGroups.id, input.groupId),
                                              eq(resourceGroups.projectId, input.projectId),
                                          ),
                                      )})`,
                        ),
                    )
                    .returning({ id: resources.id, groupId: resources.groupId });

                if (!resource)
                    throw new ORPCError("NOT_FOUND", { message: "Resource or group not found." });

                await deleteEmptyGroups(tx, [input.projectId]);

                return resource;
            }),
        ),
};
