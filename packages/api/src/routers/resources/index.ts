import { appSecret } from "@stoat/config/env";
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
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual, parseEnv } from "node:util";
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
    moveComposeEnvironment,
    postgresService,
    publishedPortNumbers,
    resourceComposePrefix,
    resourceEnv,
} from "../../compose";
import { composeResourceTypes, databaseEngine } from "../../databases";
import {
    expandSecrets,
    fillVariables,
    linkCompanions,
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
    configFilePath,
    deploymentSource,
    insertResourceDeployment,
    readComposeConfigFiles,
} from "../../resource-deployment";
import { pushGitFile, readGitHead } from "../../git";
import { buildProjectGraph } from "../../project-graph";
import { fetchDockerHubLogo, searchDockerHub } from "../../docker-hub";
import {
    addVolume,
    attachVolume,
    ComposeVolumeError,
    detachVolume,
    nextVolumeName,
    remountVolume,
    removeVolume,
} from "../../compose-volumes";
import {
    addConfig,
    attachConfig,
    ComposeConfigError,
    detachConfig,
    nextConfigName,
    removeConfig,
    setConfigContent,
    updateConfigMount,
} from "../../compose-configs";
import {
    ComposeMoveError,
    moveComposeService,
    retargetServiceReferences,
    serviceConfigFiles,
    type ComposeMove,
} from "../../compose-move";

const volumeInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    volume: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
};

const newVolumeInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    // Left out, the volume is named after its service, like Railway's `redis-volume`.
    volume: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(63))),
};

const volumeMountInput = {
    service: v.pipe(v.string(), v.minLength(1)),
    target: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
};

const configInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    config: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
};

// A Git config file, by its `configs.*.file` path as written in Compose.
const configFileInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    file: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
};

/** Rewrites a resource's Compose draft under a row lock, the way the other canvas edits do. */
function editComposeDraft(
    db: Pick<Database, "transaction">,
    resourceId: string,
    edit: (compose: string) => string,
) {
    return db.transaction(async (tx) => {
        const [resource] = await tx
            .select()
            .from(resources)
            .where(eq(resources.id, resourceId))
            .for("update");

        const compose = resource?.draftSpec?.trim() ? resource.draftSpec : resource?.spec;

        if (!resource || !compose?.trim())
            throw new ORPCError("BAD_REQUEST", {
                message: "Only Compose resources have volumes and configs.",
            });

        try {
            await tx
                .update(resources)
                .set({ draftSpec: edit(compose) })
                .where(eq(resources.id, resourceId));
        } catch (error) {
            if (error instanceof ComposeVolumeError || error instanceof ComposeConfigError)
                throw new ORPCError("BAD_REQUEST", { message: error.message });

            throw error;
        }

        return { id: resourceId };
    });
}

/** A `configs.*.file` of a Git-backed resource's draft, read from the branch head. */
async function readGitConfigFile(
    db: Database,
    organizationId: string,
    resource: typeof resources.$inferSelect,
    file: string,
) {
    const { gitSource: source, gitConnectionId: connectionId } = resource;
    const compose = resource.draftSpec ?? resource.spec ?? "";

    if (!source || !connectionId)
        throw new ORPCError("BAD_REQUEST", { message: "This resource has no Git source." });

    if (!composeConfigFiles(compose).includes(file))
        throw new ORPCError("NOT_FOUND", { message: `No config reads ${file}.` });

    const repo = await getBoundGitRepository(
        db,
        organizationId,
        connectionId,
        source.repositoryUrl,
        source.branch,
    );

    const contents = await readComposeConfigFiles(repo, source.path, compose);

    return contents[file] ?? "";
}

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
        .select({ id: projects.id, clusterId: projects.clusterId })
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

    return project;
}

/** The project, as a subquery, when it belongs to the organization and is not system-managed. */
function editableProject(db: Pick<Database, "select">, organizationId: string, projectId: string) {
    return db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                eq(projects.id, projectId),
                sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        );
}

type Resource = typeof resources.$inferSelect;

type DeployedSnapshot = { spec: string | null; prefix: string | null };

/** The latest successful deploy of each resource, which says what actually runs. */
async function deployedSnapshots(db: Database, resourceIds: string[]) {
    const rows = await db
        .selectDistinctOn([deployments.resourceId], {
            resourceId: deployments.resourceId,
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
                inArray(deployments.resourceId, resourceIds),
                eq(deployments.name, "DeployResource"),
                eq(deployments.status, "ready"),
            ),
        )
        .orderBy(deployments.resourceId, desc(deployments.finishedAt), desc(deployments.createdAt));

    return new Map<string, DeployedSnapshot>(
        rows.map(({ resourceId, ...row }) => [resourceId!, row]),
    );
}

/** The Uncloud service names a resource runs as. Throws for a deployed spec that no longer parses. */
function serviceNamesFor(
    resource: Resource,
    snapshot: DeployedSnapshot | undefined,
    monitoring: boolean,
) {
    if (monitoring) return [GREPTIME_SERVICE, ALLOY_SERVICE];

    if (!resource.spec && !resource.draftSpec) {
        throw new ORPCError("NOT_FOUND", { message: "Resource has no compose spec." });
    }

    const deployed = snapshot?.spec ?? (resource.spec?.trim() ? resource.spec : null);

    try {
        return formatComposeFile(
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
                    message: input.message ?? `Deploy ${resource.name} from Stoat`,
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
    setPendingDelete: organizationAdminProcedure
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
    deleteResource: organizationAdminProcedure
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
                const locked = await lockedComposeResource(tx, input);

                // A Git source would put them back on the next sync, so its file stays as written.
                const { compose, env } = locked.gitSource
                    ? { compose: input.spec, env: resourceEnv(locked) }
                    : moveComposeEnvironment(input.spec, resourceEnv(locked));

                const [resource] = await tx
                    .update(resources)
                    .set({
                        draftSpec: compose,
                        settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${env}::text)`,
                    })
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return resource!;
            }),
        ),

    // Volumes are Compose edits: they stage in the draft like any other change and ship on deploy.
    addVolume: organizationProcedure
        .input(v.object({ ...newVolumeInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) => {
            let volume = input.volume ?? "";

            await editComposeDraft(db, input.resourceId, (compose) => {
                volume ||= nextVolumeName(compose, input.service);

                return addVolume(compose, volume, input.service, input.target);
            });

            return { id: input.resourceId, volume };
        }),

    updateVolumeMount: organizationProcedure
        .input(
            v.object({
                ...volumeInput,
                ...volumeMountInput,
                // The path it is mounted at now, when the service mounts it at several.
                from: v.optional(v.pipe(v.string(), v.maxLength(512))),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                remountVolume(compose, input.volume, input.service, input.target, input.from),
            ),
        ),

    attachVolume: organizationProcedure
        .input(v.object({ ...volumeInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                attachVolume(compose, input.volume, input.service, input.target),
            ),
        ),

    detachVolume: organizationProcedure
        .input(v.object({ ...volumeInput, service: v.pipe(v.string(), v.minLength(1)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                detachVolume(compose, input.volume, input.service),
            ),
        ),

    deleteVolume: organizationProcedure
        .input(v.object(volumeInput))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                removeVolume(compose, input.volume),
            ),
        ),

    // Configs stage in the draft like volumes; new ones are inline `content:`, even with Git.
    addConfig: organizationProcedure
        .input(
            v.object({
                ...configInput,
                // Left out, the config is named after the file it mounts as.
                config: v.optional(configInput.config),
                ...volumeMountInput,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) => {
            let config = input.config ?? "";

            await editComposeDraft(db, input.resourceId, (compose) => {
                config ||= nextConfigName(compose, input.target);

                return addConfig(compose, config, input.service, input.target);
            });

            return { id: input.resourceId, config };
        }),

    attachConfig: organizationProcedure
        .input(v.object({ ...configInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                attachConfig(compose, input.config, input.service, input.target),
            ),
        ),

    updateConfigMount: organizationProcedure
        .input(
            v.object({
                ...configInput,
                ...volumeMountInput,
                // Octal, like 0444; empty leaves the container's default.
                mode: v.pipe(v.string(), v.maxLength(4)),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                updateConfigMount(compose, input.config, input.service, input.target, input.mode),
            ),
        ),

    detachConfig: organizationProcedure
        .input(v.object({ ...configInput, service: v.pipe(v.string(), v.minLength(1)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                detachConfig(compose, input.config, input.service),
            ),
        ),

    deleteConfig: organizationProcedure
        .input(v.object(configInput))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                removeConfig(compose, input.config),
            ),
        ),

    updateConfigContent: organizationProcedure
        .input(v.object({ ...configInput, content: v.pipe(v.string(), v.maxLength(1024 * 1024)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                setConfigContent(compose, input.config, input.content),
            ),
        ),

    // A Git config file: its staged edit if there is one, and what the branch has.
    readConfigFile: organizationProcedure
        .input(v.object(configFileInput))
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            const original = await readGitConfigFile(db, organizationId, resource, input.file);
            const draft = resource.draftConfigFiles?.[input.file];

            return { content: draft ?? original, original, edited: draft !== undefined };
        }),

    // Stages an edit of a Git config file; the next deploy commits it with the Compose draft.
    // Content matching the branch, or null, drops the edit.
    updateConfigFile: organizationProcedure
        .input(
            v.object({
                ...configFileInput,
                content: v.nullable(v.pipe(v.string(), v.maxLength(1024 * 1024))),
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            // Read before the row lock: it fetches the branch.
            const original = await readGitConfigFile(db, organizationId, resource, input.file);

            return db.transaction(async (tx) => {
                const [locked] = await tx
                    .select()
                    .from(resources)
                    .where(eq(resources.id, resource.id))
                    .for("update");

                // `original` was read from the source and Compose before the lock; both must still hold.
                if (
                    !locked?.gitSource ||
                    locked.gitConnectionId !== resource.gitConnectionId ||
                    !isDeepStrictEqual(locked.gitSource, resource.gitSource) ||
                    !composeConfigFiles(locked.draftSpec ?? locked.spec ?? "").includes(input.file)
                )
                    throw new ORPCError("CONFLICT", {
                        message: "The Git source changed. Reload the resource.",
                    });

                const { [input.file]: _previous, ...rest } = locked.draftConfigFiles ?? {};

                const files =
                    input.content === null || input.content === original
                        ? rest
                        : { ...rest, [input.file]: input.content };

                await tx
                    .update(resources)
                    .set({ draftConfigFiles: Object.keys(files).length ? files : null })
                    .where(eq(resources.id, resource.id));

                return { id: resource.id };
            });
        }),

    updateVariables: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                env: v.string(),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
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
                        sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
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
                        sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
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
                        sql`${resources.projectId} in (${editableProject(db, organizationId, input.projectId)})`,
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

            // What each resource last shipped, live or not; a cancelled deploy shipped nothing.
            // Queued and running deploys have no finishedAt, so this orders by creation.
            const lastAttempt = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    spec: deployments.spec,
                    env: resourceDeploymentInputs.env,
                    prefix: resourceDeploymentInputs.prefix,
                    status: deployments.status,
                })
                .from(deployments)
                .innerJoin(
                    resourceDeploymentInputs,
                    eq(resourceDeploymentInputs.deploymentId, deployments.id),
                )
                .where(
                    and(
                        eq(deployments.name, "DeployResource"),
                        ne(deployments.status, "cancelled"),
                    ),
                )
                .orderBy(deployments.resourceId, desc(deployments.createdAt))
                .as("last_attempt");

            const rows = await db
                .select({
                    id: resources.id,
                    slug: resources.slug,
                    projectId: resources.projectId,
                    spec: resources.spec,
                    draftSpec: resources.draftSpec,
                    draftConfigFiles: resources.draftConfigFiles,
                    pendingDelete: resources.pendingDelete,
                    settings: resources.settings,
                    deployedEnv: lastDeploy.env,
                    deployedPrefix: lastDeploy.prefix,
                    attemptedSpec: lastAttempt.spec,
                    attemptedEnv: lastAttempt.env,
                    attemptedPrefix: lastAttempt.prefix,
                    attemptedStatus: lastAttempt.status,
                })
                .from(resources)
                .leftJoin(lastDeploy, eq(lastDeploy.resourceId, resources.id))
                .leftJoin(lastAttempt, eq(lastAttempt.resourceId, resources.id))
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));

            return buildProjectGraph(
                rows.map(
                    ({
                        deployedEnv,
                        deployedPrefix,
                        attemptedSpec,
                        attemptedEnv,
                        attemptedPrefix,
                        attemptedStatus,
                        ...row
                    }) => ({
                        ...row,
                        deployed:
                            deployedEnv === null || deployedPrefix === null
                                ? null
                                : { env: deployedEnv, prefix: deployedPrefix },
                        attempted:
                            attemptedSpec === null ||
                            attemptedEnv === null ||
                            attemptedPrefix === null
                                ? null
                                : {
                                      spec: attemptedSpec,
                                      env: attemptedEnv,
                                      prefix: attemptedPrefix,
                                      failed: attemptedStatus === "failed",
                                  },
                    }),
                ),
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
        .handler(async ({ context: { db, organizationId, resource } }) => {
            const edited = resource.draftConfigFiles ?? {};
            const { gitSource, gitConnectionId } = resource;

            // What the branch has for each edited Git config file, in one fetch.
            const committed =
                Object.keys(edited).length && gitSource && gitConnectionId
                    ? await readComposeConfigFiles(
                          await getBoundGitRepository(
                              db,
                              organizationId,
                              gitConnectionId,
                              gitSource.repositoryUrl,
                              gitSource.branch,
                          ),
                          gitSource.path,
                          resource.draftSpec ?? "",
                      )
                    : {};

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
                configFiles: Object.entries(edited).map(([file, next]) => ({
                    file,
                    live: committed[file] ?? "",
                    next,
                })),
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
                /** A Docker image whose Docker Hub logo, if any, becomes the icon. */
                logoImage: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
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
                ? summarizeVersion(version).required.filter(
                      (key) => !input.template?.variables[key],
                  )
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
                version &&
                /\{\{\s*DNS\s*\}\}/iu.test(
                    [version, ...Object.values(version.companions)]
                        .map(({ compose, env }) => compose + env)
                        .join(),
                )
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
            const pasted = input.compose ? moveComposeEnvironment(input.compose, "") : undefined;

            const icon =
                !template && input.logoImage ? await fetchDockerHubLogo(input.logoImage) : null;

            // Companions get their ids first so the app's `{{ key.NAME }}` references can name them.
            const companionIds = Object.fromEntries(
                Object.keys(template?.resources ?? {}).map((key) => [key, randomUUID()]),
            );

            const companions = Object.entries(template?.resources ?? {}).flatMap(
                ([key, { name, engine }]) => {
                    const files = version?.companions[key];
                    const id = companionIds[key];

                    return files && id
                        ? [
                              {
                                  id,
                                  name: `${input.name.trim()} ${name}`.slice(0, 100),
                                  slug: resourceSlug(`${input.name} ${name}`),
                                  type: engine ? ("database" as const) : ("compose" as const),
                                  projectId: project.id,
                                  draftSpec: expandSecrets(files.compose, domain),
                                  settings: {
                                      ...(engine && { engine }),
                                      prefixNames: true,
                                      env: fillVariables(
                                          linkCompanions(
                                              expandSecrets(files.env, domain),
                                              companionIds,
                                          ),
                                          input.template?.variables ?? {},
                                      ),
                                  },
                              },
                          ]
                        : [];
                },
            );

            const created = await db
                .insert(resources)
                .values([
                    {
                        ...source,
                        ...(pasted && { draftSpec: pasted.compose, settings: { env: pasted.env } }),
                        id: randomUUID(),
                        name: input.name.trim(),
                        slug: resourceSlug(input.name),
                        description,
                        icon,
                        type: template?.type ?? input.type,
                        projectId: project.id,
                        ...(template &&
                            version && {
                                icon: template.logo,
                                draftSpec: expandSecrets(version.compose, domain),
                                settings: {
                                    ...(template.type === "database" && {
                                        engine: template.engine,
                                    }),
                                    prefixNames: true,
                                    env: fillVariables(
                                        linkCompanions(
                                            expandSecrets(version.env, domain),
                                            companionIds,
                                        ),
                                        input.template?.variables ?? {},
                                    ),
                                },
                            }),
                    },
                    ...companions,
                ])
                .returning();

            return created[0];
        }),

    // The browser can't reach Docker Hub's search (no CORS), so the server asks for it.
    searchDockerImages: organizationProcedure
        .input(v.object({ query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)) }))
        .handler(({ input }) => searchDockerHub(input.query, 8)),

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
                    appSecret(),
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
            const monitoring = await isMonitoringResource(db, resource.id);

            const snapshot = monitoring
                ? undefined
                : (await deployedSnapshots(db, [resource.id])).get(resource.id);

            const serviceNames = serviceNamesFor(resource, snapshot, monitoring);

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

    // Containers of every resource in a project from one sidecar call, so the canvas polls once
    // instead of once per card. Keyed by resource id; a resource that does not parse has none.
    getProjectContainers: organizationProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                projectId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, organizationId, organizationRole, uc }, input }) => {
            const project = await assertProjectVisible(
                db,
                organizationId,
                organizationRole,
                input.projectId,
            );

            if (project.clusterId !== input.clusterId)
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            const list = await db
                .select()
                .from(resources)
                .where(
                    and(
                        eq(resources.projectId, input.projectId),
                        inArray(resources.type, composeResourceTypes),
                    ),
                );

            if (list.length === 0) return {};

            const ids = list.map((resource) => resource.id);

            const [snapshots, monitoringRows, services] = await Promise.all([
                deployedSnapshots(db, ids),
                db
                    .select({ id: clusterMonitoring.resourceId })
                    .from(clusterMonitoring)
                    .where(inArray(clusterMonitoring.resourceId, ids)),
                unwrap(uc.GET("/api/v1/services")),
            ]);

            const monitoring = new Set(monitoringRows.map((row) => row.id));
            const byName = new Map(services.items.map((service) => [service.name, service]));

            return Object.fromEntries(
                list.map((resource) => {
                    let names: string[];

                    try {
                        names = serviceNamesFor(
                            resource,
                            snapshots.get(resource.id),
                            monitoring.has(resource.id),
                        );
                    } catch {
                        names = [];
                    }

                    return [
                        resource.id,
                        names.flatMap((name) => byName.get(name)?.containers ?? []),
                    ];
                }),
            );
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
