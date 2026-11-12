import { ORPCError } from "@orpc/server";
import {
    clusters,
    deployments,
    projects,
    resources,
    resourceDeploymentInputs,
} from "@stoat/db/schema/index";
import { ucClient } from "@stoat/uncloud";
import { composeSystemVariables } from "@stoat/workflows/compose";
import { referenceTargets, referenceKeys } from "@stoat/workflows/references";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationProcedure, resourceReadMiddleware } from "../..";
import { resourceComposePrefix, resourceEnv } from "../../compose";
import { templates } from "../../templates";
import { assertProjectVisible } from "./access";
import { getBoundGitRepository } from "../connections";
import { readComposeConfigFiles } from "../../resources/deployment";
import { buildProjectGraph } from "../../project-graph";

export const resourceGraphRouter = {
    // Services and same-project references for the project canvas; status comes from
    // `listResources`. Only resource ids leave the server, never `.env` values.
    getProjectGraph: organizationProcedure
        .input(v.object({ projectId: v.pipe(v.string(), v.uuid()) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await assertProjectVisible(db, organizationId, input.projectId);

            const [cluster] = await db
                .select({
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    sidecarCertificate: clusters.sidecarCertificate,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(eq(projects.id, input.projectId))
                .limit(1);

            // Hostless `x-ports` live on the cluster domain, left out while the sidecar is unreachable.
            const domain = cluster
                ? await ucClient(cluster.sidecarUrl, {
                      token: cluster.sidecarToken,
                      certificate: cluster.sidecarCertificate,
                  })
                      .GET("/api/v1/cluster/domain", { signal: AbortSignal.timeout(5_000) })
                      .then(({ data }) => data?.domain)
                      .catch(() => undefined)
                : undefined;

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
                domain,
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
                    sidecarCertificate: clusters.sidecarCertificate,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(eq(projects.id, resource.projectId))
                .limit(1);

            if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            // STOAT_DOMAIN is simply left out while the sidecar is unreachable.
            const { data } = await ucClient(project.sidecarUrl, {
                token: project.sidecarToken,
                certificate: project.sidecarCertificate,
            })
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

            return targets.flatMap((target) =>
                target.id === input.resourceId
                    ? []
                    : [
                          {
                              id: target.id,
                              name: target.name,
                              projectId: target.projectId,
                              projectName: target.projectName,
                              keys: referenceKeys(target),
                          },
                      ],
            );
        }),
};
