import { appSecret } from "@stoat/config/env";
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
import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import * as v from "valibot";
import { isOrganizationAdmin, organizationProcedure } from "../..";
import { formatComposeFile, resourceComposePrefix } from "../../compose";
import { pinnedVolumeName } from "../../compose-volumes";
import {
    chartPoints,
    counterTotalQuery,
    dnsMetricNames,
    dnsMetricQueries,
    httpMetricNames,
    hostGroups,
    httpQueries,
    httpSummaryQueries,
    httpTrafficMetricNames,
    caddyMetricTables,
    parseServiceSeries,
    parseTotals,
    breakdown,
    bucketQuantile,
    summarizeServices,
    type Total,
    visitorRequests,
    httpSummaryParts,
    type HttpSummary,
    type HttpSummaryPart,
    metricNames,
    metricQueries,
    metricWindow,
    parseMetricSeries,
    postgresMetricNames,
    postgresMetricQueries,
    postgresMetricTables,
    rangePresets,
    serviceHosts,
    serviceIdPattern,
    type DnsMetricName,
    type HttpMetricName,
    type MetricName,
    type ChartPoints,
    type ObservabilityRange,
    type PackedMetricSeries,
    type PostgresMetricName,
    type VolumeMetricName,
    volumeMetricNames,
    volumeMetricQueries,
    type ObservabilityContainer,
    type ObservabilityService,
} from "../../observability";

const containerInspect = v.fallback(
    v.object({
        Id: v.optional(v.string()),
        Name: v.optional(v.string()),
        RestartCount: v.optional(v.number()),
        State: v.nullish(
            v.object({
                Running: v.optional(v.boolean()),
                Status: v.optional(v.string()),
                OOMKilled: v.optional(v.boolean()),
                StartedAt: v.optional(v.string()),
                Health: v.nullish(v.object({ Status: v.string() })),
            }),
        ),
        HostConfig: v.nullish(
            v.object({ Memory: v.optional(v.number()), NanoCpus: v.optional(v.number()) }),
        ),
        Config: v.nullish(
            v.object({
                Image: v.optional(v.string()),
                Labels: v.nullish(v.record(v.string(), v.string())),
            }),
        ),
    }),
    {},
);

const unreachable = () => new ORPCError("BAD_GATEWAY", { message: "Monitoring is unreachable." });

// Shown only as the latest value, never charted, so a single sample is enough.
const latestOnly = new Set<MetricName | DnsMetricName>([
    "cores",
    "memoryTotal",
    "serviceMemory",
    "serviceNetworkIn",
    "serviceNetworkOut",
]);

const clusterInput = v.object({ clusterId: v.pipe(v.string(), v.uuid()) });

const positiveInteger = v.pipe(v.number(), v.integer(), v.gtValue(0));

const rangeInput = v.union([
    v.picklist(rangePresets),
    v.pipe(
        v.object({ from: positiveInteger, to: positiveInteger }),
        v.check(
            ({ from, to }) => to - from >= 60 && to - from <= 400 * 86400,
            "Custom ranges must span between 1 minute and 400 days.",
        ),
    ),
]);

const serviceIdsInput = v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.regex(serviceIdPattern))), v.maxLength(100)),
);

type MonitoringCluster = { id: string; password: string };

function ucServices(cluster: MonitoringCluster, uc: UcClient) {
    return swr(`uc-services:${cluster.id}`, currentWindow(), () =>
        unwrap(uc.GET("/api/v1/services", { signal: AbortSignal.timeout(30_000) })).catch(() => {
            throw unreachable();
        }),
    );
}

function monitoringPassword(cluster: MonitoringCluster) {
    return decryptMonitoringPassword(cluster.password, appSecret(), cluster.id);
}

function queryText(
    cluster: MonitoringCluster,
    uc: UcClient,
    query: string,
    start: number,
    end: number,
    step: number,
) {
    return monitoringRequest(
        uc,
        monitoringPassword(cluster),
        `/v1/prometheus/api/v1/query_range?db=${MONITORING_DATABASE}`,
        new URLSearchParams({
            query,
            start: String(start),
            end: String(end),
            step: String(step),
        }),
        AbortSignal.timeout(30_000),
    );
}

async function queryRange(
    cluster: MonitoringCluster,
    uc: UcClient,
    query: string,
    start: number,
    end: number,
    step: number,
): Promise<PackedMetricSeries[]> {
    return parseMetricSeries(
        await queryText(cluster, uc, query, start, end, step),
        start,
        end,
        step,
    );
}

/**
 * Alloy creates a metric's table with its first sample, and PromQL on a missing table fails.
 * HTTP tables appear after the first proxied request, Postgres tables after an exporter's first
 * scrape (both only once monitoring runs a config that collects them).
 */
function collecting(
    cluster: MonitoringCluster,
    uc: UcClient,
    kind: string,
    tables: readonly string[],
) {
    return swr(`${kind}-tables:${cluster.id}`, Math.floor(Date.now() / 300_000), async () => {
        // Table names are constants from this codebase, never user input.
        const rows = await greptimeSql(
            uc,
            monitoringPassword(cluster),
            `SELECT table_name FROM information_schema.tables WHERE table_schema = '${MONITORING_DATABASE}' AND table_name IN (${tables.map((table) => `'${table}'`).join(", ")})`,
            AbortSignal.timeout(30_000),
        );

        return rows.length === tables.length;
    });
}

function toContainer(
    machineId: string,
    machineName: string,
    container: v.InferOutput<typeof containerInspect>,
): ObservabilityContainer {
    const memory = container.HostConfig?.Memory;
    const cpus = container.HostConfig?.NanoCpus;
    const started = container.State?.StartedAt;

    return {
        id: container.Id ?? "",
        name: container.Name?.replace(/^\//u, "") ?? "",
        image: container.Config?.Image ?? "",
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
    series: PackedMetricSeries[];
    totals?: PackedMetricSeries[];
    /**
     * HTTP metrics: whether the services have ingress hostnames and Alloy is recording traffic.
     * Postgres metrics: whether any exporter has been scraped yet.
     */
    status: "ok" | "no-routes" | "not-collecting";
};

type ObservabilityMetricName =
    | MetricName
    | HttpMetricName
    | DnsMetricName
    | PostgresMetricName
    | VolumeMetricName;

function isHttpMetric(name: ObservabilityMetricName): name is HttpMetricName {
    return [...httpMetricNames, ...httpTrafficMetricNames].some((item) => item === name);
}

function isVolumeMetric(name: ObservabilityMetricName): name is VolumeMetricName {
    return volumeMetricNames.some((item) => item === name);
}

/** The Docker name a volume is pinned to (moved services keep theirs), from the running spec first. */
function pinnedName(resource: { spec: string | null; draftSpec: string | null }, volume: string) {
    try {
        const compose = resource.spec?.trim() ? resource.spec : resource.draftSpec;

        return compose ? pinnedVolumeName(compose, volume) : undefined;
    } catch {
        return undefined;
    }
}

async function volumeMetric(
    cluster: MonitoringCluster,
    uc: UcClient,
    name: VolumeMetricName,
    range: ObservabilityRange,
    points: ChartPoints,
    prefix: string | undefined,
    volume: string,
    services: string[],
    pinned: string | undefined,
): Promise<MetricResponse> {
    const { start, end, step } = metricWindow(range, points);

    return swr(
        `volume:${cluster.id}:${name}:${JSON.stringify(range)}:${points}:${prefix}:${volume}:${pinned}:${services.toSorted().join(",")}`,
        end,
        async () => {
            try {
                // The size table appears once a sidecar that reports volume sizes has been scraped.
                if (
                    name === "volumeSize" &&
                    !(await collecting(cluster, uc, "volume", ["stoat_volume_size_bytes"]))
                )
                    return { start, end, step, series: [], status: "not-collecting" as const };

                const query = volumeMetricQueries(
                    cluster.id,
                    step,
                    prefix,
                    volume,
                    services,
                    pinned,
                )[name];

                return {
                    start,
                    end,
                    step,
                    series: await queryRange(cluster, uc, query, start, end, step),
                    status: "ok" as const,
                };
            } catch {
                throw unreachable();
            }
        },
    );
}

function isPostgresMetric(name: ObservabilityMetricName): name is PostgresMetricName {
    return postgresMetricNames.some((item) => item === name);
}

async function postgresMetric(
    cluster: MonitoringCluster,
    uc: UcClient,
    name: PostgresMetricName,
    range: ObservabilityRange,
    points: ChartPoints,
    serviceIds: string[],
): Promise<MetricResponse> {
    const { start, end, step } = metricWindow(range, points);

    return swr(
        `postgres:${cluster.id}:${name}:${JSON.stringify(range)}:${points}:${serviceIds.toSorted().join(",")}`,
        end,
        async () => {
            try {
                if (!(await collecting(cluster, uc, "postgres", postgresMetricTables)))
                    return { start, end, step, series: [], status: "not-collecting" as const };

                const query = postgresMetricQueries(cluster.id, step, serviceIds)[name];

                return {
                    start,
                    end,
                    step,
                    series: await queryRange(cluster, uc, query, start, end, step),
                    status: "ok" as const,
                };
            } catch {
                throw unreachable();
            }
        },
    );
}

/** Each service's ingress hostnames. No service filter means the whole cluster. */
async function serviceHostMap(cluster: MonitoringCluster, uc: UcClient, serviceIds: string[]) {
    const services = await ucServices(cluster, uc);
    const hosts = new Map<string, string[]>();

    for (const service of services.items)
        if (!serviceIds.length || serviceIds.includes(service.id))
            hosts.set(service.id, [
                ...new Set(
                    service.containers.flatMap((item) =>
                        serviceHosts(
                            v.parse(containerInspect, item.container).Config?.Labels?.[
                                "uncloud.service.ports"
                            ],
                        ),
                    ),
                ),
            ]);

    return hosts;
}

/**
 * The selected services' hostnames, and whether Caddy's tables exist yet (null when GreptimeDB
 * could not be asked). Both are cached; on a miss they are two sidecar round-trips, run together.
 */
function recordedHosts(cluster: MonitoringCluster, uc: UcClient, serviceIds: string[]) {
    return Promise.all([
        serviceHostMap(cluster, uc, serviceIds),
        collecting(cluster, uc, "http", caddyMetricTables).catch(() => null),
    ]);
}

async function httpMetric(
    cluster: MonitoringCluster,
    uc: UcClient,
    name: HttpMetricName,
    range: ObservabilityRange,
    points: ChartPoints,
    serviceIds: string[],
): Promise<MetricResponse> {
    const { start, end, step } = metricWindow(range, points);
    const [hosts, recorded] = await recordedHosts(cluster, uc, serviceIds);
    const queries = httpQueries(cluster.id, step, hosts);

    if (!queries) return { start, end, step, series: [], status: "no-routes" };

    if (recorded === null) throw unreachable();

    if (!recorded) return { start, end, step, series: [], status: "not-collecting" };

    return swr(
        `http:${cluster.id}:${name}:${JSON.stringify(range)}:${points}:${JSON.stringify([...hosts].sort())}`,
        end,
        async () => {
            try {
                // Latency charts return every host's buckets, so they go a few hosts at a time.
                const groups = queries[name].quantile === undefined ? [hosts] : hostGroups(hosts);

                const series = await Promise.all(
                    groups.map(async (group) => {
                        const query = httpQueries(cluster.id, step, group)?.[name];

                        if (!query) return [];
                        const text = await queryText(cluster, uc, query.query, start, end, step);

                        return query.perHost
                            ? parseServiceSeries(text, start, end, step, group, query.quantile)
                            : parseMetricSeries(text, start, end, step);
                    }),
                );

                return { start, end, step, series: series.flat(), status: "ok" as const };
            } catch {
                throw unreachable();
            }
        },
    );
}

const noTraffic = (status: HttpSummary["status"]): HttpSummary => ({
    status,
    pending: [],
    services: [],
    latency: null,
    visitors: null,
});

type HttpSummaryPatch = Partial<Pick<HttpSummary, HttpSummaryPart>>;

/**
 * Range totals for the HTTP traffic page: per-service figures and who sent the requests. Each part
 * is cached and streamed on its own, so a slow visitor breakdown never holds back the totals.
 */
async function* httpSummary(
    cluster: MonitoringCluster,
    uc: UcClient,
    range: ObservabilityRange,
    serviceIds: string[],
): AsyncGenerator<HttpSummary> {
    const { end, duration } = metricWindow(range);
    const [hosts, recorded] = await recordedHosts(cluster, uc, serviceIds);
    const queries = httpSummaryQueries(cluster.id, duration, hosts);

    if (!queries) {
        yield noTraffic("no-routes");

        return;
    }

    if (recorded === null) throw unreachable();

    if (!recorded) {
        yield noTraffic("not-collecting");

        return;
    }

    const key = `http-summary:${cluster.id}:${JSON.stringify(range)}:${JSON.stringify([...hosts].sort())}`;

    const total = async (query: string) =>
        parseTotals(await queryText(cluster, uc, query, end, end, 15));

    // The services and the overall P95 both read the buckets, which is the heaviest scan.
    let bucketScan: Promise<Total[]> | undefined;
    const buckets = () => (bucketScan ??= total(queries.latency));

    const services = async () => {
        const [requests, bytes, latency] = await Promise.all([
            total(queries.requests),
            total(queries.bytes),
            buckets(),
        ]);

        return summarizeServices(hosts, requests, bytes, latency);
    };

    const latency = async () => bucketQuantile(0.95, await buckets());

    const visitors = async () => {
        if (!(await collecting(cluster, uc, "visitors", [visitorRequests]))) return null;

        const series = await total(queries.visitors);

        return {
            countries: breakdown(series, "country"),
            clients: breakdown(series, "client"),
            protocols: breakdown(series, "proto"),
        };
    };

    function load<T>(part: HttpSummaryPart, query: () => Promise<T>) {
        return swr(`${key}:${part}`, end, async () => {
            try {
                return await query();
            } catch {
                throw unreachable();
            }
        });
    }

    const loading = new Map<HttpSummaryPart, Promise<[HttpSummaryPart, HttpSummaryPatch]>>([
        ["services", load("services", services).then((value) => ["services", { services: value }])],
        ["latency", load("latency", latency).then((value) => ["latency", { latency: value }])],
        ["visitors", load("visitors", visitors).then((value) => ["visitors", { visitors: value }])],
    ]);

    const summary: HttpSummary = {
        status: "ok",
        pending: [...httpSummaryParts],
        services: [],
        latency: null,
        visitors: null,
    };

    // Yields in completion order; race also handles the rejections of the parts still running.
    while (loading.size) {
        const [part, patch] = await Promise.race(loading.values());
        loading.delete(part);
        Object.assign(summary, patch, { pending: [...loading.keys()] });

        // A copy, so every chunk the client caches is its own object.
        yield { ...summary };
    }
}

const monitoringMiddleware = organizationProcedure.middleware(
    async ({ context: { db, organizationId }, next }, input: { clusterId: string }) => {
        const [cluster] = await db
            .select({
                id: clusters.id,
                sidecarUrl: clusters.sidecarUrl,
                sidecarToken: clusters.sidecarToken,
                sidecarCertificate: clusters.sidecarCertificate,
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
                uc: ucClient(cluster.sidecarUrl, {
                    token: cluster.sidecarToken,
                    certificate: cluster.sidecarCertificate,
                }),
            },
        });
    },
);

export const observabilityRouter = {
    listObservableClusters: organizationProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select({
                id: clusters.id,
                name: clusters.name,
                monitored: sql<boolean>`${clusters.initializedAt} is not null`,
            })
            .from(clusters)
            // A cluster still being set up can't be monitored yet.
            .where(and(eq(clusters.organizationId, organizationId), isNull(clusters.provisioning)))
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

                    const links = new Map<string, ObservabilityService["resource"]>();

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
                                        : {
                                              projectId: resource.projectId,
                                              resourceId: resource.id,
                                          },
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
                            links.set(name, {
                                projectId: cluster.monitoringProject,
                                resourceId: cluster.monitoringResource,
                            });

                    return services.items
                        .map((service) => ({
                            id: service.id,
                            name: service.name,
                            resource: links.get(service.name) ?? null,
                            containers: service.containers
                                .map((item) =>
                                    toContainer(
                                        item.machineId,
                                        item.machineName,
                                        v.parse(containerInspect, item.container),
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
    getHttpSummary: organizationProcedure
        .input(
            v.object({
                ...clusterInput.entries,
                range: rangeInput,
                serviceIds: serviceIdsInput,
            }),
        )
        .use(monitoringMiddleware)
        .handler(({ context: { cluster, uc }, input: { range, serviceIds } }) =>
            httpSummary(cluster, uc, range, serviceIds ?? []),
        ),
    // HTTP, DNS, and Postgres metrics share this procedure to stay within tsc's router type serialization limit.
    getObservabilityMetric: organizationProcedure
        .input(
            v.object({
                ...clusterInput.entries,
                name: v.picklist([
                    ...metricNames,
                    ...httpMetricNames,
                    ...httpTrafficMetricNames,
                    ...dnsMetricNames,
                    ...postgresMetricNames,
                    ...volumeMetricNames,
                ]),
                // Scopes service metrics to these services and returns full charts instead of cluster-table shapes.
                serviceIds: serviceIdsInput,
                // Volume metrics: the resource and volume (Compose names) and the services mounting it.
                volume: v.optional(
                    v.object({
                        resourceId: v.pipe(v.string(), v.uuid()),
                        name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
                        services: v.pipe(
                            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
                            v.maxLength(100),
                        ),
                    }),
                ),
                range: rangeInput,
                // Sparklines ask for fewer points than full-size charts.
                points: v.optional(v.picklist(chartPoints), 120),
            }),
        )
        .use(monitoringMiddleware)
        .handler(
            async ({
                context: { db, cluster, uc },
                input: { name, range, points, serviceIds, volume },
            }): Promise<MetricResponse> => {
                if (isHttpMetric(name))
                    return httpMetric(cluster, uc, name, range, points, serviceIds ?? []);

                if (isVolumeMetric(name)) {
                    if (!volume)
                        throw new ORPCError("BAD_REQUEST", {
                            message: "Volume metrics need the volume and its resource.",
                        });

                    const [resource] = await db
                        .select({
                            slug: resources.slug,
                            settings: resources.settings,
                            spec: resources.spec,
                            draftSpec: resources.draftSpec,
                        })
                        .from(resources)
                        .innerJoin(projects, eq(projects.id, resources.projectId))
                        .where(
                            and(
                                eq(resources.id, volume.resourceId),
                                eq(projects.clusterId, cluster.id),
                            ),
                        );

                    if (!resource)
                        throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                    return volumeMetric(
                        cluster,
                        uc,
                        name,
                        range,
                        points,
                        resourceComposePrefix(resource),
                        volume.name,
                        volume.services,
                        pinnedName(resource, volume.name),
                    );
                }

                // Exporter series are only meaningful per resource, so they require a service scope.
                if (isPostgresMetric(name)) {
                    if (!serviceIds?.length)
                        throw new ORPCError("BAD_REQUEST", {
                            message: "Postgres metrics need the services to scope them to.",
                        });

                    return postgresMetric(cluster, uc, name, range, points, serviceIds);
                }

                const window = metricWindow(range, points);
                const { end, step } = window;
                const start = latestOnly.has(name) && !serviceIds?.length ? end : window.start;

                return swr(
                    `metric:${cluster.id}:${name}:${JSON.stringify(range)}:${points}:${serviceIds?.toSorted().join(",") ?? ""}`,
                    end,
                    async () => {
                        try {
                            const query = {
                                ...metricQueries(cluster.id, step, serviceIds),
                                ...dnsMetricQueries(cluster.id, step),
                            }[name];

                            const counter = name === "dnsQueries" || name === "dnsErrors";

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
