import { ORPCError } from "@orpc/server";
import type { Database } from "@clowder/db";
import {
    clusters,
    deployments,
    gitConnections,
    projects,
    resources,
} from "@clowder/db/schema/index";
import { queueResourceDeployment } from "@clowder/workflows/runtime";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { composeConfigFiles } from "../../compose";
import { unpushedGitSource } from "./git";
import { getBoundGitRepository, getGitConnection, gitMessage } from "../connections";
import { removeResources } from "../../resources/removal";
import {
    configFilePath,
    deploymentSource,
    insertResourceDeployment,
    readComposeConfigFiles,
} from "../../resources/deployment";
import { pushGitFile, readGitHead } from "../../git";

// A deployable resource of the organization, with the cluster its project runs on.
export function deployTarget(
    db: Pick<Database, "select">,
    organizationId: string,
    input: { projectId: string; resourceId: string },
) {
    return db
        .select({ resource: resources, clusterId: projects.clusterId })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                eq(resources.id, input.resourceId),
                eq(projects.id, input.projectId),
                sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        );
}

export const resourceDeployRouter = {
    deploy: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                recreate: v.optional(v.boolean(), false),
                // Commit on top of the branch's current head instead of failing when it moved.
                force: v.optional(v.boolean(), false),
                // Commit message used when the draft has changes that are not in Git yet.
                message: v.optional(gitMessage),
            }),
        )
        .handler(async ({ context: { db, organizationId, session }, input }) => {
            const [preview] = await deployTarget(db, organizationId, input);
            const expected = preview ? unpushedGitSource(preview.resource) : null;

            if (expected && !session?.user)
                throw new ORPCError("BAD_REQUEST", {
                    message: "Committing the draft to Git requires a signed-in user.",
                });

            // Resolved before the row lock, like pushGitSource: it opens its own transaction.
            const repo = expected
                ? await getGitConnection(
                      db,
                      organizationId,
                      expected.connectionId,
                      expected.source.repositoryUrl,
                      expected.source.branch,
                  )
                : null;

            const forcedRevision = repo && input.force ? await readGitHead(repo) : null;

            // Config files come from the branch head; the draft's own changes are pushed below.
            const gitSource = preview?.resource.gitSource;
            const connectionId = preview?.resource.gitConnectionId;
            const draft = preview?.resource.draftSpec;

            const configFiles =
                gitSource && connectionId && draft && composeConfigFiles(draft).length > 0
                    ? await readComposeConfigFiles(
                          repo ??
                              (await getBoundGitRepository(
                                  db,
                                  organizationId,
                                  connectionId,
                                  gitSource.repositoryUrl,
                                  gitSource.branch,
                              )),
                          gitSource.path,
                          draft,
                      )
                    : {};

            const id = await db.transaction(async (tx) => {
                const [row] = await deployTarget(tx, organizationId, input).for("update", {
                    of: resources,
                });

                if (!row)
                    throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
                const { resource, clusterId } = row;

                if (resource.pendingDelete)
                    throw new ORPCError("CONFLICT", {
                        message: "This resource is staged for deletion. Undo the delete first.",
                    });

                const [connection] = resource.gitConnectionId
                    ? await tx
                          .select({ provider: gitConnections.provider })
                          .from(gitConnections)
                          .where(eq(gitConnections.id, resource.gitConnectionId))
                    : [];

                const deploymentId = await insertResourceDeployment(
                    tx,
                    db,
                    resource,
                    clusterId,
                    input.recreate,
                    connection && resource.gitSource
                        ? {
                              source: deploymentSource(connection.provider),
                              trigger: "manual",
                              // Sources synced before messages were recorded have none yet.
                              commit: resource.gitSource.message
                                  ? {
                                        sha: resource.gitSource.revision,
                                        message: resource.gitSource.message,
                                    }
                                  : undefined,
                          }
                        : { source: "docker", trigger: "manual" },
                    // Edited files ship as edited; the push below commits them.
                    { ...configFiles, ...resource.draftConfigFiles },
                );

                const unpushed = unpushedGitSource(resource);

                if (!unpushed) return deploymentId;

                const { source } = unpushed;

                if (
                    !repo ||
                    !session?.user ||
                    unpushed.connectionId !== expected?.connectionId ||
                    source.repositoryUrl !== expected.source.repositoryUrl ||
                    source.branch !== expected.source.branch ||
                    source.revision !== expected.source.revision
                )
                    throw new ORPCError("CONFLICT", {
                        message: "The Git source changed. Reload the resource before deploying.",
                    });

                // A rejected push rolls back the deployment, so Git and the deployed draft agree.
                const pushed = await pushGitFile(repo, {
                    path: source.path,
                    content: unpushed.content,
                    files: Object.entries(unpushed.files).map(([file, content]) => ({
                        path: configFilePath(source.path, file),
                        content,
                    })),
                    expectedRevision: forcedRevision ?? source.revision,
                    message: input.message ?? `Deploy ${resource.name} from Clowder`,
                    author: { name: session.user.name, email: session.user.email },
                    watchPath: source.watchPath,
                    expectedTree: source.tree,
                });

                await tx
                    .update(resources)
                    .set({ gitSource: { ...source, ...pushed }, draftConfigFiles: null })
                    .where(eq(resources.id, resource.id));

                // The deployment ships the commit just pushed, not the one the draft started from.
                await tx
                    .update(deployments)
                    .set({
                        metadata: sql`${deployments.metadata} || ${JSON.stringify({
                            commit: { sha: pushed.revision, message: pushed.message },
                        })}::jsonb`,
                    })
                    .where(eq(deployments.id, deploymentId));

                // Other Compose files in the same watched directory were at the old head too; their
                // own files are untouched, so they follow the branch instead of looking conflicted.
                // A forced push may sit on remote commits that changed them, so the watcher syncs
                // those siblings instead.
                if ((forcedRevision ?? source.revision) === source.revision)
                    await tx
                        .update(resources)
                        .set({
                            gitSource: sql`${resources.gitSource} || ${JSON.stringify({
                                revision: pushed.revision,
                                message: pushed.message,
                                tree: pushed.tree,
                            })}::jsonb`,
                        })
                        .where(
                            and(
                                eq(resources.gitConnectionId, unpushed.connectionId),
                                sql`${resources.id} <> ${resource.id}`,
                                sql`${resources.gitSource}->>'repositoryUrl' = ${source.repositoryUrl}`,
                                sql`${resources.gitSource}->>'branch' = ${source.branch}`,
                                sql`${resources.gitSource}->>'watchPath' is not distinct from ${source.watchPath ?? null}::text`,
                                sql`${resources.gitSource}->>'revision' = ${source.revision}`,
                                sql`${resources.gitSource}->>'path' <> ${source.path}`,
                            ),
                        );

                return deploymentId;
            });

            // The deployment row is the durable outbox if enqueue is temporarily unavailable.
            await queueResourceDeployment(id).catch(() => {});

            return { id, status: "queued" as const };
        }),
    // Railway's "Delete Service" on the canvas: staged like any other change, applied from the bar.
    setPendingDelete: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                pendingDelete: v.boolean(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [row] = await deployTarget(db, organizationId, input);

            if (!row) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

            await db
                .update(resources)
                .set({ pendingDelete: input.pendingDelete })
                .where(eq(resources.id, row.resource.id));

            return { id: row.resource.id };
        }),
    // Removes the resources' services from the cluster (volumes stay), then the resources. One
    // batch, so resources that reference each other can be deleted together.
    deleteResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceIds: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1)),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const rows = await tx
                    .select({ resource: resources, clusterId: projects.clusterId })
                    .from(resources)
                    .innerJoin(projects, eq(resources.projectId, projects.id))
                    .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                    .where(
                        and(
                            inArray(resources.id, input.resourceIds),
                            eq(projects.id, input.projectId),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    // A fixed lock order keeps two overlapping deletes from deadlocking.
                    .orderBy(asc(resources.id))
                    .for("update", { of: resources });

                if (rows.length === 0 || rows.length !== new Set(input.resourceIds).size)
                    throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                await removeResources(
                    tx,
                    rows[0]!.clusterId,
                    rows.map((row) => row.resource),
                );

                return { ids: rows.map((row) => row.resource.id) };
            }),
        ),
};
