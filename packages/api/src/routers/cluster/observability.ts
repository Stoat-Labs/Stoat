import { ORPCError } from "@orpc/server";
import { currentWindow, swr } from "@stoat/cache";
import { clusterMonitoring, clusters, projects, resources } from "@stoat/db/schema/index";
import { ucClient, unwrap, type UcClient } from "@stoat/uncloud";
import { monitoringRequest, sql as greptimeSql } from "@stoat/workflows/greptime";
import {
    ALLOY_SERVICE,
    GREPTIME_SERVICE,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";
import { isOrganizationAdmin, organizationProcedure } from "../..";
import { formatComposeFile, resourceComposePrefix } from "../../compose";
import {
    counterTotalQuery,
    dnsMetricNames,
    dnsMetricQueries,
    registryMetricNames,
    registryMetricQueries,
    httpMetricNames,
    httpQueries,
    metricNames,
    metricQueries,
    metricWindow,
    parseMetricSeries,
    rangePresets,
    serviceHosts,
    serviceIdPattern,
    type DnsMetricName,
    type HttpMetricName,
    type RegistryMetricName,
    type MetricName,
    type MetricSeries,
    type ObservabilityRange,
    type ObservabilityContainer,
    type ObservabilityService,
} from "../../observability";

const containerInspect = z
    .object({
        Id: z.string().optional(),
        Name: z.string().optional(),
        RestartCount: z.number().optional(),
        State: z
            .object({
                Running: z.boolean().optional(),
                Status: z.string().optional(),
                OOMKilled: z.boolean().optional(),
                StartedAt: z.string().optional(),
                Health: z.object({ Status: z.string() }).nullish(),
            })
            .nullish(),
        HostConfig: z
            .object({ Memory: z.number().optional(), NanoCpus: z.number().optional() })
            .nullish(),
        Config: z.object({ Labels: z.record(z.string(), z.string()).nullish() }).nullish(),
    })
    .catch({});

const unreachable = () => new ORPCError("BAD_GATEWAY", { message: "Monitoring is unreachable." });

// Shown only as the latest value, never charted, so a single sample is enough.
const latestOnly = new Set<MetricName | DnsMetricName | RegistryMetricName>([
    "cores",
    "memoryTotal",
    "serviceMemory",
    "serviceNetworkIn",
    "serviceNetworkOut",
]);

const clusterInput = z.object({ clusterId: z.uuid() });

const rangeInput = z.union([
    z.enum(rangePresets),
    z
        .object({ from: z.int().positive(), to: z.int().positive() })
        .refine(({ from, to }) => to - from >= 60 && to - from <= 400 * 86400, {
            message: "Custom ranges must span between 1 minute and 400 days.",
        }),
]);

type MonitoringCluster = { id: string; password: string };

function ucServices(cluster: MonitoringCluster, uc: UcClient) {
    return swr(`uc-services:${cluster.id}`, currentWindow(), () =>
        unwrap(uc.GET("/api/v1/services", { signal: AbortSignal.timeout(30_000) })).catch(() => {
            throw unreachable();
        }),
    );
}

function monitoringAccess(cluster: MonitoringCluster, uc: UcClient, signal: AbortSignal) {
    const password = decryptMonitoringPassword(
        cluster.password,
        process.env.APP_SECRET ?? "",
        cluster.id,
    );

    const greptime = swr(`greptime:${cluster.id}`, currentWindow(), () =>
        unwrap(
            uc.GET("/api/v1/services/{id}", {
                params: { path: { id: GREPTIME_SERVICE } },
                signal,
            }),
        ),
    );

    return { password, greptime };
}

async function queryRange(
    cluster: MonitoringCluster,
    uc: UcClient,
    query: string,
    start: number,
    end: number,
    step: number,
): Promise<MetricSeries[]> {
    const signal = AbortSignal.timeout(30_000);
    const { password, greptime } = monitoringAccess(cluster, uc, signal);

    const text = await monitoringRequest(
        uc,
        await greptime,
        password,
        `/v1/prometheus/api/v1/query_range?db=${MONITORING_DATABASE}`,
        new URLSearchParams({
            query,
            start: String(start),
            end: String(end),
            step: String(step),
        }),
        signal,
    );

    return parseMetricSeries(text, start, end, step);
}

/** Alloy only creates the HTTP tables after the first proxied request (and after a monitoring update). */
function collectingHttp(cluster: MonitoringCluster, uc: UcClient) {
    return swr(`http-tables:${cluster.id}`, Math.floor(Date.now() / 300_000), async () => {
        const signal = AbortSignal.timeout(30_000);
        const { password, greptime } = monitoringAccess(cluster, uc, signal);

        const rows = await greptimeSql(
            uc,
            await greptime,
            password,
            `SELECT table_name FROM information_schema.tables WHERE table_schema = '${MONITORING_DATABASE}' AND table_name IN ('loki_process_custom_http_requests_total', 'loki_process_custom_http_request_duration_seconds_bucket')`,
            signal,
        );

        return rows.length === 2;
    });
}

function toContainer(
    machineId: string,
    machineName: string,
    container: z.infer<typeof containerInspect>,
): ObservabilityContainer {
    const memory = container.HostConfig?.Memory;
    const cpus = container.HostConfig?.NanoCpus;
    const started = container.State?.StartedAt;

    return {
        id: container.Id ?? "",
        name: container.Name?.replace(/^\//u, "") ?? "",
        machineId,
        machineName,
        running: container.State?.Running ?? false,
        state: container.State?.Status ?? "unknown",
        health: container.State?.Health?.Status ?? null,
        restarts: container.RestartCount ?? 0,
        oomKilled: container.State?.OOMKilled ?? false,
        // Docker reports never-started containers as year 0001.
        startedAt: started && !started.startsWith("0001") ? started : null,
        memoryLimit: memory ? memory : null,
        cpuLimit: cpus ? cpus / 1e9 : null,
    };
}

type MetricResponse = {
    start: number;
    end: number;
    step: number;
    series: MetricSeries[];
    totals?: MetricSeries[];
    /** HTTP metrics only: whether the services have ingress hostnames and Alloy is recording traffic. */
    status: "ok" | "no-routes" | "not-collecting";
};

function isHttpMetric(
    name: MetricName | HttpMetricName | DnsMetricName | RegistryMetricName,
): name is HttpMetricName {
    return httpMetricNames.some((item) => item === name);
}

async function httpMetric(
    cluster: MonitoringCluster,
    uc: UcClient,
    name: HttpMetricName,
    range: ObservabilityRange,
    serviceIds: string[],
): Promise<MetricResponse> {
    const { start, end, step } = metricWindow(range);
    const services = await ucServices(cluster, uc);
    const hosts = new Map<string, string[]>();

    // No service filter means the whole cluster, as on the HTTP traffic page.
    for (const service of services.items)
        if (!serviceIds.length || serviceIds.includes(service.id))
            hosts.set(service.id, [
                ...new Set(
                    service.containers.flatMap((item) =>
                        serviceHosts(
                            containerInspect.parse(item.container).Config?.Labels?.[
                                "uncloud.service.ports"
                            ],
                        ),
                    ),
                ),
            ]);

    const queries = httpQueries(cluster.id, step, hosts);

    if (!queries) return { start, end, step, series: [], status: "no-routes" };

    return swr(
        `http:${cluster.id}:${name}:${JSON.stringify(range)}:${JSON.stringify([...hosts].sort())}`,
        end,
        async () => {
            try {
                if (!(await collectingHttp(cluster, uc)))
                    return { start, end, step, series: [], status: "not-collecting" as const };

                return {
                    start,
                    end,
                    step,
                    series: await queryRange(cluster, uc, queries[name], start, end, step),
                    status: "ok" as const,
                };
            } catch {
                throw unreachable();
            }
        },
    );
}

const monitoringMiddleware = organizationProcedure.middleware(
    async ({ context: { db, organizationId }, next }, input: { clusterId: string }) => {
        const [cluster] = await db
            .select({
                id: clusters.id,
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
                initializedAt: clusters.initializedAt,
                password: clusterMonitoring.encryptedPassword,
                monitoringResource: clusterMonitoring.resourceId,
                monitoringProject: clusterMonitoring.projectId,
            })
            .from(clusters)
            .leftJoin(clusterMonitoring, eq(clusterMonitoring.clusterId, clusters.id))
            .where(
                and(eq(clusters.id, input.clusterId), eq(clusters.organizationId, organizationId)),
            )
            .limit(1);

        if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

        if (!cluster.initializedAt || !cluster.password)
            throw new ORPCError("PRECONDITION_FAILED", {
                message: "Initialize monitoring to collect metrics.",
            });

        return next({
            context: {
                cluster: { ...cluster, password: cluster.password },
                uc: ucClient(cluster.sidecarUrl, { token: cluster.sidecarToken }),
            },
        });
    },
);

export const observabilityRouter = {
    listObservableClusters: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select({ id: clusters.id, name: clusters.name })
            .from(clusters)
            .where(eq(clusters.organizationId, organizationId))
            .orderBy(asc(clusters.name)),
    ),
    getObservabilityMachines: organizationProcedure
        .input(clusterInput)
        .use(monitoringMiddleware)
        .handler(({ context: { cluster, uc } }) =>
            swr(`machines:${cluster.id}`, currentWindow(), async () => {
                const machines = await unwrap(
                    uc.GET("/api/v1/machines", { signal: AbortSignal.timeout(30_000) }),
                ).catch(() => {
                    throw unreachable();
                });

                return machines.items.map(({ id, name, state }) => ({ id, name, state }));
            }),
        ),
    getObservabilityServices: organizationProcedure
        .input(clusterInput)
        .use(monitoringMiddleware)
        .handler(({ context: { db, organizationRole, cluster, uc } }) =>
            swr(
                `services:${cluster.id}:${isOrganizationAdmin(organizationRole)}`,
                currentWindow(),
                async (): Promise<ObservabilityService[]> => {
                    const [services, resourceList] = await Promise.all([
                        ucServices(cluster, uc),
                        db
                            .select(getTableColumns(resources))
                            .from(resources)
                            .innerJoin(projects, eq(projects.id, resources.projectId))
                            .where(
                                and(
                                    eq(projects.clusterId, cluster.id),
                                    isOrganizationAdmin(organizationRole)
                                        ? undefined
                                        : sql`${projects.isInternal} is not true`,
                                ),
                            ),
                    ]);

                    const links = new Map<string, string | null>();

                    for (const resource of resourceList) {
                        if (!resource.spec) continue;

                        try {
                            for (const name of formatComposeFile(
                                resource.spec,
                                resourceComposePrefix(resource),
                            ).serviceNames)
                                links.set(
                                    name,
                                    links.has(name)
                                        ? null
                                        : `/projects/${resource.projectId}/${resource.id}`,
                                );
                        } catch {
                            /* An invalid imported Compose file cannot identify its services. */
                        }
                    }

                    if (
                        isOrganizationAdmin(organizationRole) &&
                        cluster.monitoringResource &&
                        cluster.monitoringProject
                    )
                        for (const name of [GREPTIME_SERVICE, ALLOY_SERVICE])
                            links.set(
                                name,
                                `/projects/${cluster.monitoringProject}/${cluster.monitoringResource}`,
                            );

                    return services.items
                        .map((service) => ({
                            id: service.id,
                            name: service.name,
                            href: links.get(service.name) ?? null,
                            containers: service.containers
                                .map((item) =>
                                    toContainer(
                                        item.machineId,
                                        item.machineName,
                                        containerInspect.parse(item.container),
                                    ),
                                )
                                .sort(
                                    (a, b) =>
                                        a.machineName.localeCompare(b.machineName) ||
                                        a.name.localeCompare(b.name),
                                ),
                        }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                },
            ),
        ),
    // HTTP and DNS metrics share this procedure to stay within tsc's router type serialization limit.
    getObservabilityMetric: organizationProcedure
        .input(
            clusterInput.extend({
                name: z.enum([
                    ...metricNames,
                    ...httpMetricNames,
                    ...dnsMetricNames,
                    ...registryMetricNames,
                ]),
                // Scopes service metrics to these services and returns full charts instead of cluster-table shapes.
                serviceIds: z.array(z.string().regex(serviceIdPattern)).max(100).optional(),
                range: rangeInput,
            }),
        )
        .use(monitoringMiddleware)
        .handler(
            async ({
                context: { cluster, uc },
                input: { name, range, serviceIds },
            }): Promise<MetricResponse> => {
                const window = metricWindow(range);

                if (isHttpMetric(name))
                    return httpMetric(cluster, uc, name, range, serviceIds ?? []);
                const { end, duration } = window;
                const scoped = Boolean(serviceIds?.length);

                // Service sparklines are ~96px wide, so 24 points is plenty.
                const step =
                    name === "serviceCpu" && !scoped
                        ? Math.ceil(duration / 24 / window.step) * window.step
                        : window.step;

                const start =
                    name === "serviceCpu" && !scoped
                        ? end - Math.floor(duration / step) * step
                        : latestOnly.has(name) && !scoped
                          ? end
                          : window.start;

                return swr(
                    `metric:${cluster.id}:${name}:${JSON.stringify(range)}:${serviceIds?.toSorted().join(",") ?? ""}`,
                    end,
                    async () => {
                        try {
                            const query = {
                                ...metricQueries(cluster.id, window.step, serviceIds),
                                ...dnsMetricQueries(cluster.id, window.step),
                                ...registryMetricQueries(cluster.id, window.step),
                            }[name];

                            const counter =
                                name === "dnsQueries" ||
                                name === "dnsErrors" ||
                                registryMetricNames.some((item) => item === name);

                            const [series, totals] = await Promise.all([
                                queryRange(cluster, uc, query, start, end, step),
                                counter
                                    ? queryRange(
                                          cluster,
                                          uc,
                                          counterTotalQuery(query, end - start),
                                          end,
                                          end,
                                          step,
                                      )
                                    : undefined,
                            ]);

                            return { start, end, step, series, totals, status: "ok" as const };
                        } catch {
                            throw unreachable();
                        }
                    },
                );
            },
        ),
};
