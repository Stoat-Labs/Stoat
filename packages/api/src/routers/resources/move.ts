import { ORPCError } from "@orpc/server";
import { clusters, projects, resources } from "@clowder/db/schema/index";
import { resourceSlug } from "@clowder/db/slug";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { deployTarget } from "./deploy";
import { resourceComposePrefix, resourceEnv } from "../../compose";
import { getBoundGitRepository } from "../connections";
import { removeResources } from "../../resources/removal";
import { readComposeConfigFiles } from "../../resources/deployment";
import {
    ComposeMoveError,
    moveComposeService,
    retargetServiceReferences,
    serviceConfigFiles,
    type ComposeMove,
} from "../../compose/move";

export const resourceMoveRouter = {
    // Drag a service onto another resource on the canvas: both drafts change, nothing deploys.
    moveService: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                fromResourceId: v.pipe(v.string(), v.uuid()),
                // Without a target the service moves into a new resource of its own: Railway's "ungroup".
                toResourceId: v.optional(v.pipe(v.string(), v.uuid())),
                service: v.pipe(v.string(), v.minLength(1)),
                // Moving a resource's last service removes that resource; the UI confirms it first.
                removeEmptySource: v.optional(v.boolean(), false),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            if (input.fromResourceId === input.toResourceId)
                throw new ORPCError("BAD_REQUEST", { message: "The service is already there." });

            // Read before the row lock, like deploy: a Git source's config files move inline.
            const [preview] = await deployTarget(db, organizationId, {
                projectId: input.projectId,
                resourceId: input.fromResourceId,
            });

            const { gitSource = null, gitConnectionId = null } = preview?.resource ?? {};
            const draft = preview?.resource.draftSpec ?? preview?.resource.spec;
            // Only the moved service's files, so another service's broken path can't block it.
            const files = draft ? serviceConfigFiles(draft, input.service) : [];

            const gitFiles =
                gitSource && gitConnectionId && draft && files.length > 0
                    ? await readComposeConfigFiles(
                          await getBoundGitRepository(
                              db,
                              organizationId,
                              gitConnectionId,
                              gitSource.repositoryUrl,
                              gitSource.branch,
                          ),
                          gitSource.path,
                          draft,
                          files,
                      )
                    : undefined;

            return db.transaction(async (tx) => {
                const rows = await tx
                    .select({ resource: resources, clusterId: projects.clusterId })
                    .from(resources)
                    .innerJoin(projects, eq(resources.projectId, projects.id))
                    .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                    .where(
                        and(
                            inArray(
                                resources.id,
                                input.toResourceId
                                    ? [input.fromResourceId, input.toResourceId]
                                    : [input.fromResourceId],
                            ),
                            eq(projects.id, input.projectId),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    // A fixed lock order keeps two opposite moves from deadlocking.
                    .orderBy(asc(resources.id))
                    .for("update", { of: resources });

                const from = rows.find((row) => row.resource.id === input.fromResourceId);

                const existing = rows.find((row) => row.resource.id === input.toResourceId);

                if (!from || (input.toResourceId && !existing))
                    throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                // A new resource starts empty and takes the service's name; it is only saved once the move works.
                const to = existing?.resource ?? {
                    id: randomUUID(),
                    name: input.service,
                    type: "compose",
                    projectId: input.projectId,
                    spec: null,
                    draftSpec: "",
                    settings: null,
                };

                const fromSpec = from.resource.draftSpec ?? from.resource.spec;
                const toSpec = existing ? (to.draftSpec ?? to.spec) : "";

                if (
                    from.resource.type === "bucket" ||
                    to.type === "bucket" ||
                    !fromSpec ||
                    toSpec === null
                )
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Services can only move between Compose resources.",
                    });

                // Git was read before the lock; a source or reference change since then would inline stale files.
                if (
                    from.resource.gitConnectionId !== gitConnectionId ||
                    !isDeepStrictEqual(from.resource.gitSource, gitSource) ||
                    !isDeepStrictEqual(serviceConfigFiles(fromSpec, input.service), files)
                )
                    throw new ORPCError("CONFLICT", {
                        message: "The resource changed while moving the service. Try again.",
                    });

                // Edits not committed yet win, as they do at deploy. Read under the lock so none are lost.
                const configFiles = gitFiles && {
                    ...gitFiles,
                    ...from.resource.draftConfigFiles,
                };

                let moved: ComposeMove;

                try {
                    moved = moveComposeService({
                        service: input.service,
                        source: fromSpec,
                        target: toSpec,
                        sourceId: from.resource.id,
                        targetId: to.id,
                        sourcePrefix: resourceComposePrefix(from.resource),
                        sourceEnv: resourceEnv(from.resource),
                        targetEnv: existing ? resourceEnv(to) : "",
                        configFiles,
                    });
                } catch (error) {
                    if (error instanceof ComposeMoveError)
                        throw new ORPCError("BAD_REQUEST", { message: error.message });

                    throw error;
                }

                if (moved.sourceEmpty && !input.removeEmptySource)
                    throw new ORPCError("PRECONDITION_FAILED", {
                        message: `Moving "${input.service}" leaves "${from.resource.name}" empty, so it would be removed.`,
                    });

                if (existing)
                    await tx
                        .update(resources)
                        .set({
                            draftSpec: moved.target,
                            settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${moved.targetEnv}::text)`,
                        })
                        .where(eq(resources.id, to.id));
                else
                    await tx.insert(resources).values({
                        id: to.id,
                        name: to.name,
                        slug: resourceSlug(to.name),
                        type: "compose",
                        projectId: input.projectId,
                        // A split-out service stays in the frame it was drawn in.
                        groupId: from.resource.groupId,
                        draftSpec: moved.target,
                        // A split keeps the stack's naming, so an unprefixed stack stays unprefixed.
                        settings: resourceComposePrefix(from.resource)
                            ? { env: moved.targetEnv }
                            : { env: moved.targetEnv, prefixNames: false },
                    });

                // Resources elsewhere in the project that referenced the service follow it too, before
                // an emptied source is removed, which refuses while anything still references it.
                const readers = await tx
                    .select({
                        id: resources.id,
                        name: resources.name,
                        projectId: resources.projectId,
                        settings: resources.settings,
                    })
                    .from(resources)
                    .innerJoin(projects, eq(resources.projectId, projects.id))
                    .where(
                        and(
                            eq(projects.clusterId, from.clusterId),
                            notInArray(resources.id, [from.resource.id, to.id]),
                            sql`${resources.settings}->>'env' ilike ${`%${from.resource.id}%`}`,
                        ),
                    )
                    .orderBy(asc(resources.id))
                    .for("update", { of: resources });

                for (const reader of readers) {
                    const env = resourceEnv(reader);

                    const next = retargetServiceReferences(
                        env,
                        from.resource.id,
                        to.id,
                        input.service,
                    );

                    if (next === env) continue;

                    // Apply only deploys this project, so a reader elsewhere would keep the old host.
                    if (reader.projectId !== input.projectId)
                        throw new ORPCError("CONFLICT", {
                            message: `"${reader.name}" in another project references "${input.service}". Remove the reference from its variables first.`,
                        });

                    await tx
                        .update(resources)
                        .set({
                            settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${next}::text)`,
                        })
                        .where(eq(resources.id, reader.id));
                }

                if (moved.sourceEmpty) await removeResources(tx, from.clusterId, [from.resource]);
                else
                    await tx
                        .update(resources)
                        .set({
                            draftSpec: moved.source,
                            settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${moved.sourceEnv}::text)`,
                        })
                        .where(eq(resources.id, from.resource.id));

                return {
                    warnings: moved.warnings,
                    removedResourceId: moved.sourceEmpty ? from.resource.id : null,
                    resourceId: to.id,
                };
            });
        }),
};
