import { ORPCError } from "@orpc/server";
import {
    clusterMonitoring,
    clusters,
    deployments,
    deploymentLogs,
    projects,
    resources,
    resourceDeploymentInputs,
    s3Buckets,
    type DeploymentStatus,
} from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import {
    GREPTIME_SERVICE,
    ALLOY_SERVICE,
    GREPTIME_USERNAME,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { ComposeVariableError, composeVariables } from "@stoat/workflows/compose";
import {
    checkVariableReferences,
    referencedResourceIds,
    referenceTargets,
    referenceVariables,
    resolveReferences,
} from "@stoat/workflows/references";
import { queueResourceDeployment } from "@stoat/workflows/runtime";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
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
    composePublishedPorts,
    enablePostgresPort,
    formatComposeFile,
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
} from "./git";
import { gitText } from "../connections";
import { machineName } from "../cluster/initialization";
import { isMonitoringResource, resourceLogsRouter } from "./logs";
import { removeResources } from "../../resource-removal";

export const resourcesRouter = {
    ...resourceGitRouter,
    ...resourceLogsRouter,
    deploy: organizationAdminProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
                recreate: v.optional(v.boolean(), false),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const id = await db.transaction(async (tx) => {
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

                if (!row)
                    throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
                const { resource, clusterId } = row;

                if (!resource.draftSpec?.trim())
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Save a Compose spec before deploying.",
                    });

                if (Buffer.byteLength(resource.draftSpec) > 4 * 1024 * 1024)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "Compose must not exceed 4 MiB.",
                    });

                const prefix = resourceComposePrefix(resource) ?? "";

                try {
                    if (formatComposeFile(resource.draftSpec, prefix).serviceCount === 0)
                        throw new Error("Compose must contain at least one service.");
                } catch {
                    throw new ORPCError("BAD_REQUEST", {
                        message:
                            "Save a valid Compose spec containing at least one service before deploying.",
                    });
                }

                // Fail fast on broken references; the worker resolves them again at deploy time.
                const env = resourceEnv(resource);

                try {
                    await checkVariableReferences(
                        db,
                        clusterId,
                        resource.id,
                        resource.draftSpec,
                        env,
                    );
                } catch (error) {
                    if (!(error instanceof ComposeVariableError)) throw error;
                    throw new ORPCError("BAD_REQUEST", { message: error.message });
                }

                const [active] = await tx
                    .select({ id: deployments.id })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.resourceId, resource.id),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    )
                    .limit(1);

                if (active)
                    throw new ORPCError("CONFLICT", {
                        message: "This resource already has an active deployment.",
                    });

                const deploymentId = randomUUID();
                await tx.insert(deployments).values({
                    id: deploymentId,
                    jobId: deploymentId,
                    clusterId,
                    resourceId: resource.id,
                    name: "DeployResource",
                    status: "queued",
                    spec: resource.draftSpec,
                });
                await tx.insert(resourceDeploymentInputs).values({
                    deploymentId,
                    prefix,
                    env,
                    recreate: input.recreate,
                });
                await tx.insert(deploymentLogs).values({
                    deploymentId,
                    text: "Resource deployment queued. Saved Compose snapshot captured.",
                    metadata: { level: "info" },
                });

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
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
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

            const latest = db
                .selectDistinctOn([deployments.resourceId], {
                    resourceId: deployments.resourceId,
                    id: deployments.id,
                    status: deployments.status,
                    progress: deployments.progress,
                    createdAt: deployments.createdAt,
                    finishedAt: deployments.finishedAt,
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
                    bucketStatus: s3Buckets.status,
                })
                .from(resources)
                .leftJoin(latest, eq(latest.resourceId, resources.id))
                .leftJoin(s3Buckets, eq(s3Buckets.resourceId, resources.id))
                .where(eq(resources.projectId, input.projectId))
                .orderBy(asc(resources.createdAt));
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

            if (input.template && input.git) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose either a template or a Git source.",
                });
            }

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
                    id: randomUUID(),
                    name: input.name.trim(),
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

                env = composeVariables(resource.draftSpec, envText, prefix, undefined, references);
            } catch {
                env = parseEnv(envText);
            }

            const url = (host: string, port: number) =>
                `postgresql://${encodeURIComponent(env.POSTGRES_USER ?? "postgres")}:${encodeURIComponent(env.POSTGRES_PASSWORD ?? "")}@${host}:${port}/${encodeURIComponent(env.POSTGRES_DB ?? env.POSTGRES_USER ?? "postgres")}`;

            const internal = url(`${prefix ? `${prefix}-` : ""}${service.name}.internal`, 5432);

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
