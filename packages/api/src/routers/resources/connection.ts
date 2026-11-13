import { ORPCError } from "@orpc/server";
import { clusters, deployments, projects, resources } from "@clowder/db/schema/index";
import { unwrap } from "@clowder/uncloud";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import {
    organizationProcedure,
    resourceMiddleware,
    resourceReadMiddleware,
    uncloudMiddleware,
} from "../..";
import {
    composePublishedPorts,
    enablePostgresPort,
    formatComposeFile,
    internalHostname,
    postgresService,
    publishedPortNumbers,
    resourceComposePrefix,
} from "../../compose";
import { databaseEngine } from "../../databases";
import { lockedComposeResource, resourceEditInput } from "./git";
import { postgresEnv } from "./postgres";

export const resourceConnectionRouter = {
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
            const env = await postgresEnv(db, input.clusterId, resource, resource.draftSpec);

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
};
