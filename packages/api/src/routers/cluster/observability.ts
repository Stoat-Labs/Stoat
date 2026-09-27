import { ORPCError } from "@orpc/server";
import { clusterMonitoring, clusters, projects, resources } from "@stoat/db/schema/index";
import { ucClient, unwrap } from "@stoat/uncloud";
import { monitoringRequest } from "@stoat/workflows/greptime";
import {
    ALLOY_SERVICE,
    GREPTIME_SERVICE,
    MONITORING_DATABASE,
} from "@stoat/workflows/monitoring-compose";
import { decryptMonitoringPassword } from "@stoat/workflows/secrets";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { createStorage } from "unstorage";
import lruCacheDriver from "unstorage/drivers/lru-cache";
import { z } from "zod";
import { isOrganizationAdmin, organizationProcedure } from "../..";
import { formatComposeFile, resourceComposePrefix } from "../../compose";
import {
    metricNames,
    metricQueries,
    metricWindow,
    parseMetricSeries,
    rangePresets,
    type MetricName,
    type MetricSeries,
    type ObservabilityService,
} from "../../observability";

const containerState = z.object({ State: z.object({ Running: z.boolean() }).optional() });

// ponytail: per-process memory cache; move to a shared driver (e.g. redis) if the web app scales out.
const cache = createStorage({ driver: lruCacheDriver({ max: 1000, ttl: 10 * 60_000 }) });

const inflight = new Map<string, Promise<unknown>>();

/**
 * Stale-while-revalidate keyed on a 15s-aligned window: the previous window is served instantly
 * while one shared fetch refreshes it, so nobody waits on the cluster after the first load.
 */
async function swr<T>(key: string, window: number, load: () => Promise<T>): Promise<T> {
    const cached = await cache.getItem<{ window: number; value: T }>(key);

    if (cached?.window === window) return cached.value;

    const refresh =
        // SAFETY: keys embed the procedure name, so one key always resolves to one T.
        (inflight.get(key) as Promise<T> | undefined) ??
        load()
            .then(async (value) => {
                await cache.setItem(key, { window, value });

                return value;
            })
            .finally(() => {
                inflight.delete(key);
            });

    inflight.set(key, refresh);

    if (cached) {
        refresh.catch(() => {});

        return cached.value;
    }

    return refresh;
}

const currentWindow = () => Math.floor(Date.now() / 15_000);

const unreachable = () => new ORPCError("BAD_GATEWAY", { message: "Monitoring is unreachable." });

// Shown only as the latest value, never charted, so a single sample is enough.
const latestOnly = new Set<MetricName>([
    "cores",
    "memoryTotal",
    "serviceMemory",
    "serviceNetworkIn",
    "serviceNetworkOut",
]);

const clusterInput = z.object({ clusterId: z.uuid() });

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
                        unwrap(
                            uc.GET("/api/v1/services", { signal: AbortSignal.timeout(30_000) }),
                        ).catch(() => {
                            throw unreachable();
                        }),
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

                    const result: ObservabilityService[] = [];

                    for (const service of services.items) {
                        const rows = new Map<string, ObservabilityService>();

                        for (const item of service.containers) {
                            const row = rows.get(item.machineId) ?? {
                                id: service.id,
                                name: service.name,
                                machineId: item.machineId,
                                machineName: item.machineName,
                                running: 0,
                                containers: 0,
                                href: links.get(service.name) ?? null,
                            };

                            row.containers++;
                            const state = containerState.safeParse(item.container);

                            if (state.success && state.data.State?.Running) row.running++;
                            rows.set(item.machineId, row);
                        }

                        if (!rows.size)
                            rows.set("", {
                                id: service.id,
                                name: service.name,
                                machineId: "",
                                machineName: "Unscheduled",
                                running: 0,
                                containers: 0,
                                href: links.get(service.name) ?? null,
                            });
                        result.push(...rows.values());
                    }

                    return result.sort(
                        (a, b) =>
                            a.name.localeCompare(b.name) ||
                            a.machineName.localeCompare(b.machineName),
                    );
                },
            ),
        ),
    getObservabilityMetric: organizationProcedure
        .input(
            clusterInput.extend({
                name: z.enum(metricNames),
                range: z.union([
                    z.enum(rangePresets),
                    z
                        .object({ from: z.int().positive(), to: z.int().positive() })
                        .refine(({ from, to }) => to - from >= 60 && to - from <= 400 * 86400, {
                            message: "Custom ranges must span between 1 minute and 400 days.",
                        }),
                ]),
            }),
        )
        .use(monitoringMiddleware)
        .handler(({ context: { cluster, uc }, input: { name, range } }) => {
            const window = metricWindow(range);
            const { end, duration } = window;

            // Service sparklines are ~96px wide, so 24 points is plenty.
            const step =
                name === "serviceCpu"
                    ? Math.ceil(duration / 24 / window.step) * window.step
                    : window.step;

            const start =
                name === "serviceCpu"
                    ? end - Math.floor(duration / step) * step
                    : latestOnly.has(name)
                      ? end
                      : window.start;

            return swr(
                `metric:${cluster.id}:${name}:${JSON.stringify(range)}`,
                end,
                async (): Promise<{
                    start: number;
                    end: number;
                    step: number;
                    series: MetricSeries[];
                }> => {
                    const signal = AbortSignal.timeout(30_000);

                    try {
                        const password = decryptMonitoringPassword(
                            cluster.password,
                            process.env.BETTER_AUTH_SECRET ?? "",
                            cluster.id,
                        );

                        const greptime = await swr(`greptime:${cluster.id}`, currentWindow(), () =>
                            unwrap(
                                uc.GET("/api/v1/services/{id}", {
                                    params: { path: { id: GREPTIME_SERVICE } },
                                    signal,
                                }),
                            ),
                        );

                        const text = await monitoringRequest(
                            uc,
                            greptime,
                            password,
                            `/v1/prometheus/api/v1/query_range?db=${MONITORING_DATABASE}`,
                            new URLSearchParams({
                                query: metricQueries(cluster.id, window.step)[name],
                                start: String(start),
                                end: String(end),
                                step: String(step),
                            }),
                            signal,
                        );

                        return {
                            start,
                            end,
                            step,
                            series: parseMetricSeries(text, start, end, step),
                        };
                    } catch {
                        throw unreachable();
                    }
                },
            );
        }),
};
