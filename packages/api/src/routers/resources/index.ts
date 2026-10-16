import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    clusterMonitoring,
    clusters,
    deployments,
    gitConnections,
    projects,
    resources,
    resourceDeploymentInputs,
    s3Buckets,
    type DeploymentMetadata,
    type DeploymentStatus,
} from "@stoat/db/schema/index";
import { resourceSlug } from "@stoat/db/slug";
import { ucClient, unwrap } from "@stoat/uncloud";
import {
    GREPTIME_SERVICE,
    ALLOY_SERVICE,
    GREPTIME_USERNAME,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { composeSystemVariables, composeVariables } from "@stoat/workflows/compose";
import {
    referencedResourceIds,
    referenceTargets,
    referenceVariables,
    resolveReferences,
} from "@stoat/workflows/references";
import { queueResourceDeployment } from "@stoat/workflows/runtime";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import * as v from "valibot";

import {
    isOrganizationAdmin,
    organizationAdminProcedure,
    organizationProcedure,
    resourceMiddleware,
    resourceReadMiddleware,
    uncloudMiddleware,
} from "../..";
import {
    composeConfigFiles,
    composePublishedPorts,
    enablePostgresPort,
    formatComposeFile,
    internalHostname,
    postgresService,
    publishedPortNumbers,
    resourceComposePrefix,
    resourceEnv,
} from "../../compose";
import { composeResourceTypes, databaseEngine } from "../../databases";
import {
    expandSecrets,
    fillVariables,
    requiredVariables,
    summarizeVersion,
    templates,
} from "../../templates";
import {
    gitSourceInput,
    loadGitCompose,
    lockedComposeResource,
    resourceEditInput,
    resourceGitRouter,
    unpushedGitSource,
    validateCompose,
} from "./git";
import { resourceDiscardRouter } from "./discard";
import { resourceTransferRouter } from "./transfer";
import { getBoundGitRepository, getGitConnection, gitMessage, gitText } from "../connections";
import { machineName } from "../cluster/initialization";
import { isMonitoringResource, resourceLogsRouter } from "./logs";
import { removeResources } from "../../resource-removal";
import {
    deploymentSource,
    insertResourceDeployment,
    readComposeConfigFiles,
} from "../../resource-deployment";
import { pushGitFile, readGitHead } from "../../git";
import { buildProjectGraph } from "../../project-graph";
import {
    ComposeMoveError,
    moveComposeService,
    retargetServiceReferences,
    type ComposeMove,
} from "../../compose-move";

// A deployable resource of the organization, with the cluster its project runs on.
function deployTarget(
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

// Internal projects are only visible to organization admins.
async function assertProjectVisible(
    db: Pick<Database, "select">,
    organizationId: string,
    organizationRole: string,
    projectId: string,
) {
    const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                eq(projects.id, projectId),
                isOrganizationAdmin(organizationRole)
                    ? undefined
                    : sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        )
        .limit(1);

    if (!project) {
        throw new ORPCError("NOT_FOUND", { message: "Project not found." });
    }
}

export const resourcesRouter = {
    ...resourceGitRouter,
    ...resourceTransferRouter,
    ...resourceDiscardRouter,
    ...resourceLogsRouter,
    deploy: organizationAdminProcedure
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
                    configFiles,
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
                    expectedRevision: forcedRevision ?? source.revision,
                    message: input.message ?? `Deploy ${resource.name} from Stoat`,
                    author: { name: session.user.name, email: session.user.email },
                    watchPath: source.watchPath,
                    expectedTree: source.tree,
                });

                await tx
                    .update(resources)
                    .set({ gitSource: { ...source, ...pushed } })
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
    // Removes the resource's services from the cluster (volumes stay), then the resource.
    deleteResource: organizationAdminProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [row] = await tx
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
                    )
                    .for("update", { of: resources });

                if (!row) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                await removeResources(tx, row.clusterId, [row.resource]);

                return { id: row.resource.id };
            }),
        ),
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
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            if (input.fromResourceId === input.toResourceId)
                throw new ORPCError("BAD_REQUEST", { message: "The service is already there." });

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

                if (moved.sourceEmpty && !isOrganizationAdmin(organizationRole))
                    throw new ORPCError("FORBIDDEN", {
                        message: "Only owners and admins can remove resources.",
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
                        draftSpec: moved.target,
                        // A split keeps the stack's naming, so an unprefixed stack stays unprefixed.
                        settings: resourceComposePrefix(from.resource)
                            ? { env: moved.targetEnv }
                            : { env: moved.targetEnv, prefixNames: false },
                    });

                // Resources elsewhere on the cluster that referenced the service follow it too, before
                // an emptied source is removed, which refuses while anything still references it.
                const readers = await tx
                    .select({ id: resources.id, settings: resources.settings })
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

                    if (next !== env)
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

    updateComposeSpec: organizationProcedure
        .input(
            v.object({
                ...resourceEditInput,
                spec: gitText,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) =>
            db.transaction(async (tx) => {
                await lockedComposeResource(tx, input);

                const [resource] = await tx
                    .update(resources)
                    .set({ draftSpec: input.spec })
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return resource!;
            }),
        ),

    updateVariables: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                env: v.string(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${input.env}::text)`,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateSettings: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                prefixNames: v.boolean(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const [resource] = await db
                .update(resources)
                .set({
                    settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('prefixNames', ${input.prefixNames}::boolean)`,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    updateDetails: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                icon: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000_000))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const authorizedProjects = db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                );

            const description = input.description?.trim() ? input.description.trim() : null;
            const icon = input.icon?.trim() ? input.icon.trim() : null;

            const [resource] = await db
                .update(resources)
                .set({
                    name: input.name.trim(),
                    description,
                    icon,
                })
                .where(
                    and(
                        eq(resources.id, input.resourceId),
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                        sql`${resources.projectId} in (${authorizedProjects})`,
                    ),
                )
                .returning();

            if (!resource) {
                throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
            }

            return resource;
        }),

    listResources: organizationProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            await assertProjectVisible(db, organizationId, organizationRole, input.projectId);

            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    id: deployments.id,
                    status: deployments.status,
                    progress: deployments.progress,
                    createdAt: deployments.createdAt,
                    finishedAt: deployments.finishedAt,
                    source: sql<
                        DeploymentMetadata["source"] | null
                    >`${deployments.metadata}->>'source'`.as("source"),
                })
                .from(deployments)
                .innerJoin(resources, eq(deployments.resourceId, resources.id))
                .where(
                    and(
                        eq(deployments.name, "DeployResource"),
                        eq(resources.projectId, input.projectId),
                    ),
                )
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("latest");

            return db
                .select({
                    id: resources.id,
                    name: resources.name,
                    description: resources.description,
                    icon: resources.icon,
                    type: resources.type,
                    engine: sql<string | null>`${resources.settings}->>'engine'`,
                    projectId: resources.projectId,
                    gitBranch: sql<string | null>`${resources.gitSource}->>'branch'`,
                    createdAt: resources.createdAt,
                    updatedAt: resources.updatedAt,
                    deploymentId: latest.id,
                    deploymentStatus: sql<DeploymentStatus | null>`${latest.status}`,
                    deploymentProgress: latest.progress,
                    deploymentCreatedAt: latest.createdAt,
                    deploymentFinishedAt: latest.finishedAt,
                    deploymentSource: latest.source,
                    bucketStatus: s3Buckets.status,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                .leftJoin(s3Buckets, eq(s3Buckets.resourceId, resources.id))
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));
        }),

    // Services and same-project references for the project canvas; status comes from
    // `listResources`. Only resource ids leave the server, never `.env` values.
    getProjectGraph: organizationProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId, organizationRole }, input }) => {
            await assertProjectVisible(db, organizationId, organizationRole, input.projectId);

            // What each resource last deployed with, to tell which saved edits are not live yet.
            const lastDeploy = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    env: resourceDeploymentInputs.env,
                    prefix: resourceDeploymentInputs.prefix,
                })
                .from(deployments)
                .innerJoin(
                    resourceDeploymentInputs,
                    eq(resourceDeploymentInputs.deploymentId, deployments.id),
                )
                .where(and(eq(deployments.name, "DeployResource"), eq(deployments.status, "ready")))
                .orderBy(
                    deployments.resourceId,
                    sql`${deployments.finishedAt} desc nulls last`,
                    desc(deployments.createdAt),
                )
                .as("last_deploy");

            const rows = await db
                .select({
                    id: resources.id,
                    slug: resources.slug,
                    projectId: resources.projectId,
                    spec: resources.spec,
                    draftSpec: resources.draftSpec,
                    settings: resources.settings,
                    deployedEnv: lastDeploy.env,
                    deployedPrefix: lastDeploy.prefix,
                })
                .from(resources)
                .leftJoin(lastDeploy, eq(lastDeploy.resourceId, resources.id))
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));

            return buildProjectGraph(
                rows.map(({ deployedEnv, deployedPrefix, ...row }) => ({
                    ...row,
                    deployed:
                        deployedEnv === null || deployedPrefix === null
                            ? null
                            : { env: deployedEnv, prefix: deployedPrefix },
                })),
                templates,
            );
        }),

    // Railway's "Details" on staged changes: what is live next to what the next deploy ships.
    // Variables are included because getResource already shows them to the same readers.
    getPendingChanges: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource } }) => {
            const [live] = await db
                .select({
                    env: resourceDeploymentInputs.env,
                    prefix: resourceDeploymentInputs.prefix,
                })
                .from(deployments)
                .innerJoin(
                    resourceDeploymentInputs,
                    eq(resourceDeploymentInputs.deploymentId, deployments.id),
                )
                .where(
                    and(
                        eq(deployments.resourceId, resource.id),
                        eq(deployments.name, "DeployResource"),
                        eq(deployments.status, "ready"),
                    ),
                )
                .orderBy(
                    sql`${deployments.finishedAt} desc nulls last`,
                    desc(deployments.createdAt),
                )
                .limit(1);

            let env = "";

            try {
                env = resourceEnv(resource);
            } catch {
                // An unreadable `.env` shows as empty; the Variables page reports it.
            }

            return {
                firstDeploy: !resource.spec?.trim(),
                compose: {
                    live: resource.spec ?? "",
                    next: resource.draftSpec ?? resource.spec ?? "",
                },
                env: { live: live?.env ?? "", next: env },
                prefix: {
                    live: live?.prefix ?? null,
                    next: resourceComposePrefix(resource) ?? "",
                },
            };
        }),

    // Railway's "variables added by Railway": the built-ins this resource's Compose sees.
    listSystemVariables: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource } }) => {
            const compose = resource.draftSpec?.trim() ? resource.draftSpec : resource.spec;

            if (!compose?.trim()) return [];

            const [project] = await db
                .select({
                    name: projects.name,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(eq(projects.id, resource.projectId))
                .limit(1);

            if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            // STOAT_DOMAIN is simply left out while the sidecar is unreachable.
            const { data } = await ucClient(project.sidecarUrl, { token: project.sidecarToken })
                .GET("/api/v1/cluster/domain", { signal: AbortSignal.timeout(5_000) })
                .catch(() => ({ data: undefined }));

            const identity = {
                projectId: resource.projectId,
                projectName: project.name,
                resourceId: resource.id,
                resourceName: resource.name,
            };

            const list = (envText: string) =>
                composeSystemVariables(
                    compose,
                    envText,
                    resourceComposePrefix(resource),
                    data?.domain,
                    identity,
                );

            try {
                return list(resourceEnv(resource));
            } catch {
                // Broken Variables only cost the public domains built from them.
                try {
                    return list("");
                } catch {
                    return [];
                }
            }
        }),

    // Keys only: values never leave the server for autocomplete.
    listVariableReferences: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .select({ clusterId: projects.clusterId })
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

            const targets = await referenceTargets(db, project.clusterId);

            return targets.flatMap((target) => {
                if (target.id === input.resourceId) return [];
                let keys: string[];

                try {
                    keys = Object.keys(referenceVariables(target));
                } catch {
                    keys = Object.keys(parseEnv(resourceEnv(target)));
                }

                return [
                    {
                        id: target.id,
                        name: target.name,
                        projectId: target.projectId,
                        projectName: target.projectName,
                        keys: keys.toSorted(),
                    },
                ];
            });
        }),

    createResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                type: v.optional(v.picklist(["compose"]), "compose"),
                git: v.optional(gitSourceInput),
                /** A starting Compose draft, e.g. one service running a Docker image. */
                compose: v.optional(gitText),
                template: v.optional(
                    v.object({
                        appId: v.string(),
                        version: v.string(),
                        variables: v.optional(
                            v.record(
                                v.string(),
                                v.pipe(
                                    v.string(),
                                    v.trim(),
                                    v.regex(/^[^\r\n]*$/u, "Variables must be a single line."),
                                    v.check(
                                        (value) => !["'", '"', "`"].every((q) => value.includes(q)),
                                        "Variables can't mix all three quote characters.",
                                    ),
                                    v.maxLength(4096),
                                ),
                            ),
                            {},
                        ),
                    }),
                ),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const template = templates.find((t) => t.appId === input.template?.appId);
            const version = input.template && template?.versions[input.template.version];

            if (input.template && !version) {
                throw new ORPCError("NOT_FOUND", { message: "Template not found." });
            }

            const missing = version
                ? requiredVariables(version.env).filter((key) => !input.template?.variables[key])
                : [];

            if (missing.length > 0) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `Set the required variables: ${missing.join(", ")}.`,
                });
            }

            if ([input.template, input.git, input.compose].filter(Boolean).length > 1) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose one of a template, a Git source or a Compose file.",
                });
            }

            if (input.compose) validateCompose(input.compose);

            const [project] = await db
                .select({
                    id: projects.id,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                })
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

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            const domain =
                version && /\{\{\s*DNS\s*\}\}/iu.test(version.compose + version.env)
                    ? await unwrap(
                          ucClient(project.sidecarUrl, { token: project.sidecarToken }).GET(
                              "/api/v1/cluster/domain",
                          ),
                      ).then(
                          ({ domain }) => domain,
                          () => {
                              throw new ORPCError("BAD_REQUEST", {
                                  message:
                                      "This template needs the cluster's reserved domain, which is unavailable.",
                              });
                          },
                      )
                    : undefined;

            const description = input.description?.trim() ? input.description.trim() : null;
            const source = input.git ? await loadGitCompose(db, organizationId, input.git) : {};

            const [resource] = await db
                .insert(resources)
                .values({
                    ...source,
                    ...(input.compose && { draftSpec: input.compose }),
                    id: randomUUID(),
                    name: input.name.trim(),
                    slug: resourceSlug(input.name),
                    description,
                    type: template?.type ?? input.type,
                    projectId: project.id,
                    ...(template &&
                        version && {
                            icon: template.logo,
                            draftSpec: expandSecrets(version.compose, domain),
                            settings: {
                                ...(template.type === "database" && { engine: template.engine }),
                                prefixNames: true,
                                env: fillVariables(
                                    expandSecrets(version.env, domain),
                                    input.template?.variables ?? {},
                                ),
                            },
                        }),
                })
                .returning();

            return resource;
        }),

    listTemplates: organizationProcedure.handler(() =>
        templates.map(({ versions, ...template }) => ({
            ...template,
            versions: Object.entries(versions)
                .map(([version, files]) => ({ version, ...summarizeVersion(files) }))
                // Integer-like keys ("18") lose insertion order, so sort newest first here.
                .toSorted((a, b) =>
                    b.version.localeCompare(a.version, undefined, { numeric: true }),
                ),
        })),
    ),

    enableExternalConnection: organizationProcedure
        .input(v.object({ ...resourceEditInput, clusterId: v.pipe(v.string(), v.uuid()) }))
        .use(resourceMiddleware)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc }, input }) =>
            db.transaction(async (tx) => {
                // Serialize automatic port selection across every resource in this cluster.
                await tx
                    .select({ id: clusters.id })
                    .from(clusters)
                    .where(eq(clusters.id, input.clusterId))
                    .for("update");
                const resource = await lockedComposeResource(tx, input);

                if (databaseEngine(resource) !== "postgresql" || !resource.draftSpec?.trim())
                    throw new ORPCError("BAD_REQUEST", {
                        message: "A PostgreSQL Compose draft is required.",
                    });

                const { items } = await unwrap(
                    uc.GET("/api/v1/services", {
                        signal: AbortSignal.timeout(15_000),
                    }),
                );

                const saved = await tx
                    .select({ draftSpec: resources.draftSpec, spec: resources.spec })
                    .from(resources)
                    .innerJoin(projects, eq(resources.projectId, projects.id))
                    .where(eq(projects.clusterId, input.clusterId));

                const queued = await tx
                    .select({ spec: deployments.spec })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.clusterId, input.clusterId),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    );

                const occupied = new Set<number>();
                let draftSpec: string;

                try {
                    for (const row of saved) {
                        for (const spec of [row.draftSpec, row.spec]) {
                            if (spec?.trim())
                                for (const port of composePublishedPorts(spec)) occupied.add(port);
                        }
                    }

                    for (const row of queued) {
                        if (row.spec?.trim())
                            for (const port of composePublishedPorts(row.spec)) occupied.add(port);
                    }

                    for (const service of items) {
                        for (const entry of [...service.containers, ...service.hookContainers]) {
                            const inspection = v.parse(
                                v.object({
                                    Config: v.optional(
                                        v.object({
                                            Labels: v.optional(
                                                v.nullable(v.record(v.string(), v.string())),
                                            ),
                                        }),
                                    ),
                                }),
                                entry.container,
                            );

                            const ports =
                                inspection.Config?.Labels?.["uncloud.service.ports"] ?? "";

                            for (const spec of ports.split(",")) {
                                for (const port of publishedPortNumbers(spec.trim()))
                                    occupied.add(port);
                            }
                        }
                    }

                    draftSpec = enablePostgresPort(resource.draftSpec, occupied);
                    formatComposeFile(draftSpec, resourceComposePrefix(resource));
                } catch {
                    throw new ORPCError("BAD_REQUEST", {
                        message:
                            "Could not safely select an external port. Check the cluster's Compose drafts for invalid YAML or unresolved port variables, or configure a host port manually.",
                    });
                }

                const [updated] = await tx
                    .update(resources)
                    .set({ draftSpec })
                    .where(eq(resources.id, resource.id))
                    .returning();

                return updated!;
            }),
        ),

    getConnection: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource, uc }, input }) => {
            if (databaseEngine(resource) !== "postgresql" || !resource.draftSpec) return null;

            let service;

            try {
                service = postgresService(resource.draftSpec);
            } catch {
                return null;
            }

            if (!service) return null;

            const prefix = resourceComposePrefix(resource);
            const envText = resourceEnv(resource);
            let env: Record<string, string | undefined>;

            // Resolved like a deploy would, so referenced and interpolated passwords are real.
            try {
                const ids = referencedResourceIds(envText);

                const targets =
                    ids.length > 0 ? await referenceTargets(db, input.clusterId, ids) : [];

                const references = resolveReferences(envText, targets, undefined, resource.id);

                const [project] = await db
                    .select({ name: projects.name })
                    .from(projects)
                    .where(eq(projects.id, resource.projectId));

                // `STOAT_PROJECT_*` / `STOAT_RESOURCE_*` resolve like the deploy does.
                env = composeVariables(resource.draftSpec, envText, prefix, undefined, references, {
                    projectId: resource.projectId,
                    projectName: project?.name ?? "",
                    resourceId: resource.id,
                    resourceName: resource.name,
                });
            } catch {
                env = parseEnv(envText);
            }

            const url = (host: string, port: number) =>
                `postgresql://${encodeURIComponent(env.POSTGRES_USER ?? "postgres")}:${encodeURIComponent(env.POSTGRES_PASSWORD ?? "")}@${host}:${port}/${encodeURIComponent(env.POSTGRES_DB ?? env.POSTGRES_USER ?? "postgres")}`;

            const internal = url(internalHostname(service.name, prefix), 5432);

            if (!service.published)
                return { internal, external: null, externalPort: null, pendingDeployment: false };

            let deployedService;

            try {
                deployedService = resource.spec ? postgresService(resource.spec) : undefined;
            } catch {
                // An unreadable deployed spec cannot confirm that this port was deployed.
                deployedService = undefined;
            }

            const pendingDeployment =
                service.name !== deployedService?.name ||
                service.published.port !== deployedService?.published?.port ||
                service.published.host !== deployedService?.published?.host;

            let host = service.published.host;

            if (!host) {
                const { data } = await uc.GET("/api/v1/machines", {
                    signal: AbortSignal.timeout(15_000),
                });

                const machines = data?.items ?? [];

                host =
                    machines.find((machine) => machine.publicIp)?.publicIp ?? machines[0]?.hostname;
            }

            return {
                internal,
                external: host ? url(host, service.published.port) : null,
                externalPort: service.published.port,
                pendingDeployment,
            };
        }),

    getResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource } }) => {
            const [monitoring] = await db
                .select({
                    clusterId: clusterMonitoring.clusterId,
                    encryptedPassword: clusterMonitoring.encryptedPassword,
                    configuration: clusters.initializationConfiguration,
                    initializedAt: clusters.initializedAt,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                })
                .from(clusterMonitoring)
                .innerJoin(clusters, eq(clusters.id, clusterMonitoring.clusterId))
                .where(eq(clusterMonitoring.resourceId, resource.id))
                .limit(1);

            if (!monitoring) return resource;

            // Monitoring values are injected at deploy time and never stored as resource env.
            // Only admins reach this branch: internal resources are admin-only reads.
            let password = "";

            try {
                password = decryptMonitoringPassword(
                    monitoring.encryptedPassword,
                    process.env.APP_SECRET ?? "",
                    monitoring.clusterId,
                );
            } catch {
                password = "";
            }

            const saved = monitoring.configuration?.machine ?? "";

            // Pre-rename configurations stored an ID; show its current name when reachable.
            const machine = await unwrap(
                ucClient(monitoring.sidecarUrl, { token: monitoring.sidecarToken }).GET(
                    "/api/v1/machines",
                    { signal: AbortSignal.timeout(5_000) },
                ),
            ).then(
                ({ items }) => machineName(items, saved),
                () => saved,
            );

            const env = [
                ["GREPTIME_URL", `http://${GREPTIME_SERVICE}.internal:4006`],
                ["GREPTIME_DB", MONITORING_DATABASE],
                ["GREPTIME_USERNAME", GREPTIME_USERNAME],
                ["GREPTIME_PASSWORD", password],
                ["GREPTIME_MACHINE", machine],
                ["CLUSTER_ID", monitoring.clusterId],
                ["RETENTION_DAYS", String(monitoring.configuration?.retentionDays ?? "")],
            ]
                .map(([key, value]) => `${key}=${value}`)
                .join("\n");

            // The initialized stack is the deployed template; expose it so views treat it as deployed.
            return {
                ...resource,
                spec: monitoring.initializedAt ? resource.draftSpec : resource.spec,
                settings: { ...monitoring.configuration, machine, env: `${env}\n` },
            };
        }),
    getContainers: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .use(resourceReadMiddleware)
        .handler(async ({ context: { db, resource, uc } }) => {
            let serviceNames: string[] = [GREPTIME_SERVICE, ALLOY_SERVICE];

            if (!(await isMonitoringResource(db, resource.id))) {
                if (!resource.spec && !resource.draftSpec) {
                    throw new ORPCError("NOT_FOUND", {
                        message: "Resource has no compose spec.",
                    });
                }

                const [snapshot] = await db
                    .select({
                        spec: deployments.spec,
                        prefix: resourceDeploymentInputs.prefix,
                    })
                    .from(deployments)
                    .leftJoin(
                        resourceDeploymentInputs,
                        eq(resourceDeploymentInputs.deploymentId, deployments.id),
                    )
                    .where(
                        and(
                            eq(deployments.resourceId, resource.id),
                            eq(deployments.name, "DeployResource"),
                            eq(deployments.status, "ready"),
                        ),
                    )
                    .orderBy(desc(deployments.finishedAt), desc(deployments.createdAt))
                    .limit(1);

                const deployed = snapshot?.spec ?? (resource.spec?.trim() ? resource.spec : null);

                try {
                    serviceNames = formatComposeFile(
                        deployed ?? resource.draftSpec!,
                        snapshot?.prefix ?? resourceComposePrefix(resource),
                    ).serviceNames;
                } catch (error) {
                    // Before the first deploy the draft is only a guess at what runs, and an
                    // unfinished one is not an error worth showing next to the editor.
                    if (!deployed) return [];

                    throw new ORPCError("BAD_REQUEST", {
                        message: error instanceof Error ? error.message : "Invalid compose spec.",
                    });
                }
            }

            const containers = await Promise.all(
                serviceNames.map(async (id) => {
                    const result = await uc.GET("/api/v1/services/{id}", {
                        params: { path: { id } },
                    });

                    if (result.response.status === 404) return [];

                    const service = await unwrap(Promise.resolve(result));

                    return service.containers;
                }),
            );

            return containers.flat();
        }),
    getFormattedCompose: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceReadMiddleware)
        .handler(({ context: { resource } }) => {
            if (!resource.draftSpec) {
                throw new ORPCError("NOT_FOUND", { message: "Resource has no compose draft." });
            }

            const prefix = resourceComposePrefix(resource);

            try {
                const formatted = formatComposeFile(resource.draftSpec, prefix);

                return { ...formatted, prefix };
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", {
                    message: error instanceof Error ? error.message : "Invalid compose spec.",
                });
            }
        }),
};
