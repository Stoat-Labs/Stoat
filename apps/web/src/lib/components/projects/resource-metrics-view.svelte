<script lang="ts">
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import { browser } from "$app/environment";
    import { page } from "$app/state";
    import { ago } from "$lib/format";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import ServicesTable from "$lib/components/observability/services-table.svelte";
    import AddDatabaseMetrics from "./add-database-metrics.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        assembleCluster,
        bandwidth,
        bytes,
        count,
        current,
        duration,
        percent,
        perSecond,
        rankCpu,
        rankMemory,
        rankTraffic,
        requests,
        serviceRows,
        serviceSeries,
        sumPoints,
        unpackMetric,
        type ChartSeries,
        type MetricUnit,
    } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import {
        databaseExporterEngine,
        databaseServerEngine,
        hasMysqlExporter,
        hasPostgresExporter,
        httpMetricNames,
        isMysqlExporter,
        isPostgresExporter,
        mysqlMetricNames,
        postgresMetricNames,
        type MetricSeries,
    } from "@stoat/api/observability";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import LayoutGrid from "@lucide/svelte/icons/layout-grid";
    import Rows3 from "@lucide/svelte/icons/rows-3";
    import {
        parseAsBoolean,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";

    const names = [
        "serviceCpu",
        "serviceMemory",
        "serviceNetworkIn",
        "serviceNetworkOut",
    ] as const;

    let {
        projectId,
        resourceId,
        embedded = false,
    }: {
        projectId: string;
        resourceId: string;
        /** Inside the project canvas panel the toolbar renders inline, not in the app header. */
        embedded?: boolean;
    } = $props();

    const range = useObservabilityRange();

    syncMetricCharts();

    const paused = useQueryState(
        "paused",
        parseAsBoolean.withDefault(false),
    );

    let selectedTime = $state<number | null>(null);

    const project = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: browser && projectId.length > 0,
        }),
    );

    const clusterId = $derived(project.data?.clusterId ?? "");

    const options = $derived({
        enabled: browser && clusterId.length > 0,
        refetchInterval:
            paused.current || range.custom
                ? (false as const)
                : 30_000,
        retry: false,
        staleTime: 25_000,
    });

    const services = createQuery(() =>
        orpc.cluster.getObservabilityServices.queryOptions({
            input: { clusterId },
            ...options,
        }),
    );

    // The services procedure already maps Uncloud services to the resource that deploys them.
    const resourceServices = $derived(
        (services.data ?? []).filter(
            (service) =>
                service.resource?.projectId === projectId &&
                service.resource.resourceId === resourceId,
        ),
    );

    const serviceIds = $derived([
        ...new Set(resourceServices.map((service) => service.id)),
    ]);

    const graph = createQuery(() =>
        orpc.resources.getProjectGraph.queryOptions({
            input: { projectId },
            enabled: browser && projectId.length > 0,
        }),
    );

    // An exporter in its own resource points at this one through a variable reference.
    const referrers = $derived(
        new Set(
            (graph.data?.resources ?? [])
                .filter((entry) =>
                    entry.references.includes(resourceId),
                )
                .map((entry) => entry.id),
        ),
    );

    const referrerServices = $derived(
        (services.data ?? []).filter(
            (service) =>
                service.resource?.projectId === projectId &&
                referrers.has(service.resource.resourceId),
        ),
    );

    // Both engines list their metrics in the same order: connections, max connections,
    // throughput, cache hit ratio, size.
    const engines = {
        postgres: {
            label: "PostgreSQL",
            exporter: "postgres-exporter",
            throughput: "Transactions",
            names: postgresMetricNames,
            isExporter: isPostgresExporter,
            hasExporter: hasPostgresExporter,
        },
        mysql: {
            label: "MySQL",
            exporter: "mysqld-exporter",
            throughput: "Queries",
            names: mysqlMetricNames,
            isExporter: isMysqlExporter,
            hasExporter: hasMysqlExporter,
        },
    };

    // An exporter referencing this resource scrapes it, whatever the image (timescaledb, postgis...).
    // Otherwise, any resource running the server next to its exporter.
    const engine = $derived(
        Object.values(engines).find(
            (item) =>
                referrerServices.some(item.isExporter) ||
                item.hasExporter(resourceServices),
        ),
    );

    // A database server not scraped yet: offered an exporter, or told one is on its way.
    const pendingEngine = $derived.by(() => {
        const entries = graph.data?.resources ?? [];

        // The graph resolves `${DB_IMAGE:-mariadb:13}` to its default; running containers report
        // the image a set variable picked.
        const server = [
            ...(entries.find((entry) => entry.id === resourceId)
                ?.services ?? []),
            ...resourceServices.flatMap(
                (service) => service.containers,
            ),
        ]
            .map(
                (item) =>
                    item.image && databaseServerEngine(item.image),
            )
            .find(Boolean);

        const planned = entries.some(
            (entry) =>
                (entry.id === resourceId ||
                    entry.references.includes(resourceId)) &&
                entry.services.some(
                    (service) =>
                        service.image &&
                        databaseExporterEngine(service.image) ===
                            server,
                ),
        );

        return server && !engine
            ? { ...engines[server], planned }
            : undefined;
    });

    // Alloy tags exporter series with the exporter's own service ID.
    const databaseServiceIds = $derived([
        ...serviceIds,
        ...referrerServices
            .filter((service) => engine?.isExporter(service))
            .map((service) => service.id),
    ]);

    const metrics = createQueries(() => ({
        queries: names.map((name) =>
            orpc.cluster.getObservabilityMetric.queryOptions({
                input: {
                    clusterId,
                    name,
                    range: range.value,
                    serviceIds,
                },
                select: unpackMetric,
                ...options,
                enabled: options.enabled && serviceIds.length > 0,
            }),
        ),
    }));

    const http = createQueries(() => ({
        queries: httpMetricNames.map((name) =>
            orpc.cluster.getObservabilityMetric.queryOptions({
                input: {
                    clusterId,
                    name,
                    range: range.value,
                    serviceIds,
                },
                select: unpackMetric,
                ...options,
                enabled: options.enabled && serviceIds.length > 0,
            }),
        ),
    }));

    const database = createQueries(() => ({
        queries: (engine?.names ?? []).map((name) =>
            orpc.cluster.getObservabilityMetric.queryOptions({
                input: {
                    clusterId,
                    name,
                    range: range.value,
                    serviceIds: databaseServiceIds,
                },
                select: unpackMetric,
                ...options,
                enabled: options.enabled && engine !== undefined,
            }),
        ),
    }));

    const deployments = createQuery(() =>
        orpc.cluster.listAllDeployments.queryOptions({
            input: { resourceId, limit: 100 },
            enabled: browser && resourceId.length > 0,
        }),
    );

    const cluster = $derived(
        assembleCluster(
            { id: clusterId, name: project.data?.clusterName ?? "" },
            { data: [], error: null, isPending: false },
            services,
            metrics,
            names,
        ),
    );

    const rows = $derived(
        serviceRows([cluster]).filter((row) =>
            serviceIds.includes(row.id),
        ),
    );

    const charts = $derived([
        {
            title: "CPU",
            unit: "percent" as const,
            total: percent(sum(rows.map((row) => row.cpu))),
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceCpu"],
                rankCpu,
                rows.length,
            ),
        },
        {
            title: "Memory",
            unit: "bytes" as const,
            total: bytes(sum(rows.map((row) => row.memory))),
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceMemory"],
                rankMemory,
                rows.length,
            ),
        },
        {
            title: "Network · receive",
            unit: "rate" as const,
            total: bandwidth(sum(rows.map((row) => row.networkIn))),
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceNetworkIn"],
                rankTraffic,
                rows.length,
            ),
        },
        {
            title: "Network · send",
            unit: "rate" as const,
            total: bandwidth(sum(rows.map((row) => row.networkOut))),
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceNetworkOut"],
                rankTraffic,
                rows.length,
            ),
        },
    ]);

    const [
        requestQuery,
        errorQuery,
        latencyQuery,
        latencyP50Query,
        latencyP99Query,
    ] = $derived(http);

    const httpStatus = $derived(requestQuery?.data?.status);

    const httpSeries = $derived.by(() => {
        const perService = (
            series: MetricSeries[] | undefined,
        ): ChartSeries[] =>
            rows.flatMap((row, index) => {
                const points = sumPoints(
                    (series ?? []).flatMap((item) =>
                        item.serviceId === row.id
                            ? [item.points]
                            : [],
                    ),
                );

                return points.length
                    ? [
                          {
                              key: `${row.key}:http`,
                              machineKey: row.key,
                              label: row.name,
                              color: `var(--chart-${(index % 5) + 1})`,
                              points,
                          },
                      ]
                    : [];
            });

        return {
            requests: perService(requestQuery?.data?.series),
            errors: perService(errorQuery?.data?.series),
            latency: perService(latencyQuery?.data?.series),
            latencyP50: perService(latencyP50Query?.data?.series),
            latencyP99: perService(latencyP99Query?.data?.series),
        };
    });

    const httpCharts = $derived.by(() => {
        const totals = new Map(
            httpSeries.requests.map((item) => [
                item.machineKey,
                new Map(
                    item.points.map((point) => [
                        point.time,
                        point.value,
                    ]),
                ),
            ]),
        );

        const errorRate = httpSeries.errors.map((item) => ({
            ...item,
            points: item.points.map((point) => {
                const total = totals
                    .get(item.machineKey)
                    ?.get(point.time);

                return {
                    time: point.time,
                    value:
                        point.value !== null && total
                            ? (100 * point.value) / total
                            : null,
                };
            }),
        }));

        return [
            {
                title: "Requests",
                unit: "requests" as const,
                series: httpSeries.requests,
            },
            {
                title: "Error rate · 5xx",
                unit: "percent" as const,
                series: errorRate,
            },
            {
                title: "Latency · p95",
                unit: "duration" as const,
                series: httpSeries.latency,
            },
            {
                title: "Latency · p50 / p99",
                unit: "duration" as const,
                series: [
                    ...httpSeries.latencyP50,
                    ...httpSeries.latencyP99.map((item) => ({
                        ...item,
                        key: `${item.key}:p99`,
                        dashed: true,
                    })),
                ],
            },
        ];
    });

    // One line per metric: a moved exporter leaves per-machine series that never overlap in time.
    const databasePoints = $derived(
        database.map((query) =>
            sumPoints(
                (query.data?.series ?? []).map((item) => item.points),
            ),
        ),
    );

    // `not-collecting` means no exporter was scraped yet; an empty result means not this one.
    const databaseCollecting = $derived(
        database[0]?.data?.status === "ok" &&
            (databasePoints[0]?.length ?? 0) > 0,
    );

    const databaseLatest = (index: number) =>
        current(
            databasePoints[index] ?? [],
            cluster.end,
            cluster.step,
        );

    const databaseCharts = $derived(
        (
            [
                ["Connections", "count", 0],
                [engine?.throughput ?? "", "perSecond", 2],
                ["Cache hit ratio", "percent", 3],
                ["Database size", "bytes", 4],
            ] as const
        ).flatMap(([title, unit, index]) => {
            const points = databasePoints[index] ?? [];

            // mysqld-exporter only reports sizes with `--collect.info_schema.schema_size`.
            if (index === 4 && points.length === 0) return [];

            return [
                {
                    title,
                    unit,
                    total: { count, perSecond, percent, bytes }[unit](
                        databaseLatest(index),
                    ),
                    series: [
                        {
                            key: title,
                            machineKey: title,
                            label: engine?.label ?? "",
                            color: "var(--chart-1)",
                            points,
                        },
                    ],
                },
            ];
        }),
    );

    // Services without traffic report gaps, so HTTP totals skip them instead of blanking the sum.
    const latest = (series: ChartSeries[]) =>
        series.flatMap((item) => {
            const value = current(
                item.points,
                cluster.end,
                cluster.step,
            );

            return value === null ? [] : [value];
        });

    const requestRate = $derived(
        latest(httpSeries.requests).reduce(
            (total, value) => total + value,
            0,
        ),
    );

    const errorRate = $derived(
        requestRate
            ? (100 *
                  latest(httpSeries.errors).reduce(
                      (total, value) => total + value,
                      0,
                  )) /
                  requestRate
            : null,
    );

    // ponytail: slowest service's p95, not a true combined p95; merge histogram buckets if that matters.
    const latency = $derived(
        latest(httpSeries.latency).reduce<number | null>(
            (slowest, value) => Math.max(slowest ?? 0, value),
            null,
        ),
    );

    const containers = $derived(
        rows.flatMap((row) => row.containers),
    );

    const cpuLimit = $derived(
        containers.length &&
            containers.every((item) => item.cpuLimit !== null)
            ? sum(containers.map((item) => item.cpuLimit))
            : null,
    );

    const memoryLimit = $derived(
        containers.length &&
            containers.every((item) => item.memoryLimit !== null)
            ? sum(containers.map((item) => item.memoryLimit))
            : null,
    );

    const lastDeploy = $derived(
        deployments.data?.items.find(
            (item) =>
                item.status === "ready" || item.status === "failed",
        ),
    );

    const summary = $derived.by(() => {
        const running = containers.filter(
            (item) => item.running,
        ).length;

        const unhealthy = containers.filter(
            (item) => item.health === "unhealthy",
        ).length;

        const oom = containers.filter(
            (item) => item.oomKilled,
        ).length;

        const restarts = containers.reduce(
            (total, item) => total + item.restarts,
            0,
        );

        const cpu = sum(rows.map((row) => row.cpu));
        const memory = sum(rows.map((row) => row.memory));
        const connections = databaseLatest(0);

        const maxConnections = databaseLatest(1);

        return [
            {
                label: "Containers",
                value: `${running}/${containers.length} running`,
                detail: unhealthy
                    ? `${unhealthy} unhealthy`
                    : running < containers.length
                      ? "Some containers are not running"
                      : "All running",
                tone:
                    running < containers.length || unhealthy
                        ? "warning"
                        : "",
            },
            {
                label: "Restarts",
                value: String(restarts),
                detail: oom
                    ? `${oom} out-of-memory kill${oom === 1 ? "" : "s"}`
                    : "Since containers were created",
                tone: oom ? "error" : restarts ? "warning" : "",
            },
            {
                label: "CPU",
                value: percent(cpu),
                detail: cpuLimit
                    ? `of ${cpuLimit.toLocaleString()} core limit${cpu !== null ? ` · ${percent(cpu / cpuLimit)}` : ""}`
                    : "No CPU limit · 100% = one core",
                tone:
                    cpu !== null && cpuLimit && cpu / cpuLimit >= 90
                        ? "warning"
                        : "",
            },
            {
                label: "Memory",
                value: bytes(memory),
                detail: memoryLimit
                    ? `of ${bytes(memoryLimit)} limit${memory !== null ? ` · ${percent((100 * memory) / memoryLimit)}` : ""}`
                    : "No memory limit",
                tone:
                    memory !== null &&
                    memoryLimit &&
                    memory / memoryLimit >= 0.9
                        ? "error"
                        : "",
            },
            ...(httpStatus === "ok"
                ? [
                      {
                          label: "HTTP",
                          value: requests(requestRate),
                          detail: `${percent(errorRate)} 5xx · p95 ${duration(latency)}`,
                          tone:
                              errorRate !== null && errorRate >= 5
                                  ? "error"
                                  : "",
                      },
                  ]
                : []),
            ...(databaseCollecting
                ? [
                      {
                          label: "Connections",
                          value: count(connections),
                          detail: maxConnections
                              ? `of ${count(maxConnections)} max`
                              : "Max connections unknown",
                          tone:
                              connections !== null &&
                              maxConnections &&
                              connections / maxConnections >= 0.8
                                  ? "warning"
                                  : "",
                      },
                  ]
                : []),
            {
                label: "Last deploy",
                value: lastDeploy
                    ? ago(
                          lastDeploy.finishedAt ??
                              lastDeploy.createdAt,
                          Date.now(),
                      )
                    : "—",
                detail: lastDeploy
                    ? lastDeploy.status === "failed"
                        ? "Failed"
                        : "Succeeded"
                    : "No deployments yet",
                tone: lastDeploy?.status === "failed" ? "error" : "",
            },
        ];
    });

    const markers = $derived(
        (deployments.data?.items ?? []).flatMap((item) => {
            const time = new Date(item.createdAt).getTime();

            return item.status !== "cancelled" &&
                time >= cluster.start * 1000 &&
                time <= cluster.end * 1000
                ? [
                      {
                          key: item.id,
                          time,
                          label:
                              item.status === "failed"
                                  ? "Failed deploy"
                                  : "Deploy",
                      },
                  ]
                : [];
        }),
    );

    const pending = $derived(
        project.isPending ||
            services.isPending ||
            (serviceIds.length > 0 &&
                !cluster.available &&
                metrics.some((query) => query.isPending)),
    );

    const fetching = $derived(
        services.isFetching ||
            [...metrics, ...http, ...database].some(
                (query) => query.isFetching,
            ),
    );

    function sum(values: (number | null)[]) {
        return values.length &&
            values.every((value) => value !== null)
            ? values.reduce<number>(
                  (total, value) => total + (value ?? 0),
                  0,
              )
            : null;
    }

    function logsHref(from: number, to: number) {
        // The canvas panel opens its own Logs tab on that range instead of leaving the canvas.
        if (embedded) {
            const params = new URLSearchParams(page.url.searchParams);
            params.set("tab", "logs");
            params.set("logStart", new Date(from).toISOString());
            params.set("logEnd", new Date(to).toISOString());

            return `?${params}`;
        }

        const params = new URLSearchParams({
            logMode: "search",
            logRange: "custom",
            logStart: new Date(from).toISOString(),
            logEnd: new Date(to).toISOString(),
            logServices: rows.map((row) => row.name).join(","),
        });

        return `/projects/${projectId}/${resourceId}/logs?${params}`;
    }

    function clock(time: number) {
        return new Date(time).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    useHeaderActions(toolbar, () => !embedded);

    // Railway's list or grid of charts in the canvas panel.
    const layout = useQueryState(
        "metricsLayout",
        parseAsStringLiteral(["grid", "list"])
            .withDefault("grid")
            .withOptions({ shallow: true, scroll: false }),
    );
</script>

{#snippet toolbar()}
    <div
        class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"
    >
        {#if embedded}
            <div
                class="flex overflow-hidden rounded-md border"
                role="group"
                aria-label="Chart layout"
            >
                {#each [{ value: "list", label: "List", icon: Rows3 }, { value: "grid", label: "Grid", icon: LayoutGrid }] as const as option (option.value)}
                    <button
                        type="button"
                        class={[
                            "flex size-8 items-center justify-center transition-colors",
                            layout.current === option.value
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                        ]}
                        aria-label="{option.label} layout"
                        aria-pressed={layout.current === option.value}
                        onclick={() =>
                            void layout.set(
                                option.value === "grid"
                                    ? null
                                    : option.value,
                            )}
                    >
                        <option.icon
                            class="size-4"
                            aria-hidden="true"
                        />
                    </button>
                {/each}
            </div>
        {/if}
        {#if cluster.available && rows.length}<a
                class={buttonVariants({
                    variant: "outline",
                    size: "sm",
                })}
                href={logsHref(
                    cluster.start * 1000,
                    cluster.end * 1000,
                )}
            >
                Logs for this range
            </a>{/if}
        <!-- Nothing to range over or refresh until the cluster has monitoring. -->
        {#if cluster.reason !== "uninitialized"}
            <RangeControls
                {range}
                bind:paused={paused.current}
                {fetching}
                disabled={!clusterId}
                onrefresh={() => {
                    void services.refetch();
                    for (const query of [
                        ...metrics,
                        ...http,
                        ...database,
                    ])
                        void query.refetch();
                }}
            />
        {/if}
    </div>
{/snippet}

{#snippet chartFrame(chart: {
    title: string;
    unit: MetricUnit;
    total?: string;
    series: ChartSeries[];
})}
    {#if embedded}
        <!-- Railway's chart card: one flat surface, the title and current value on top. -->
        <section class="min-w-0 rounded-lg border bg-card p-4">
            <header
                class="mb-3 flex items-center justify-between gap-2"
            >
                <h4 class="font-medium">{chart.title}</h4>
                {#if chart.total}<span
                        class="text-xs text-muted-foreground tabular-nums"
                    >
                        {chart.total}
                    </span>{/if}
            </header>
            <MetricChart
                series={chart.series}
                start={cluster.start}
                end={cluster.end}
                unit={chart.unit}
                {markers}
                onselecttime={(time) => (selectedTime = time)}
            />
        </section>
    {:else}
        <Frame class="min-w-0">
            <FrameHeader
                class="flex-row flex-wrap items-center justify-between gap-2"
            >
                <FrameTitle>
                    {chart.title}
                </FrameTitle>{#if chart.total}<span
                        class="text-xs font-medium tabular-nums"
                    >
                        {chart.total}
                    </span>{/if}
            </FrameHeader>
            <FramePanel class="min-w-0 p-4">
                <MetricChart
                    series={chart.series}
                    start={cluster.start}
                    end={cluster.end}
                    unit={chart.unit}
                    {markers}
                    onselecttime={(time) => (selectedTime = time)}
                />
            </FramePanel>
        </Frame>
    {/if}
{/snippet}

{#if embedded}
    {@render toolbar()}
{/if}

<div
    class="@container min-w-0 w-full space-y-4 overflow-x-clip pt-4 sm:space-y-6 sm:pt-6"
>
    {#if project.isError}
        <Alert variant="error">
            <AlertDescription>
                Could not load this project. <button
                    class="underline"
                    onclick={() => project.refetch()}
                >
                    Try again
                </button>
            </AlertDescription>
        </Alert>
    {:else if cluster.reason}
        <Alert variant="warning">
            <AlertDescription>
                {cluster.reason === "uninitialized"
                    ? "Initialize monitoring on this cluster to collect metrics."
                    : "Monitoring is unreachable."}
                <a
                    class="underline underline-offset-2"
                    href={`/clusters/${clusterId}`}
                >
                    Open cluster
                </a>
            </AlertDescription>
        </Alert>
    {:else if cluster.unavailable.length}
        <Alert variant="info">
            <AlertDescription>
                Some metrics are unavailable ({cluster.unavailable.join(
                    ", ",
                )}).
            </AlertDescription>
        </Alert>
    {/if}

    {#if pending}
        <Skeleton loading loading-label="Loading resource metrics">
            <div class="grid gap-4 lg:grid-cols-2">
                {#each ["CPU", "Memory", "Network · receive", "Network · send"] as title (title)}<Frame
                        class="min-w-0"
                    >
                        <FrameHeader>
                            <FrameTitle>{title}</FrameTitle>
                        </FrameHeader><FramePanel class="min-w-0 p-4">
                            <div class="h-40 min-w-0 w-full sm:h-48">
                                Loading chart
                            </div>
                        </FramePanel>
                    </Frame>{/each}
            </div>
        </Skeleton>
    {:else if services.isSuccess && !serviceIds.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    No running services
                </EmptyTitle><EmptyDescription>
                    Deploy this resource to start collecting metrics
                    for its services.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else if cluster.available}
        {#if !embedded}<div class="flex flex-wrap gap-3">
                {#each summary as item (item.label)}
                    <div
                        class="min-w-36 flex-1 rounded-lg border p-3 {item.tone ===
                        'error'
                            ? 'border-destructive/40'
                            : item.tone === 'warning'
                              ? 'border-warning/40'
                              : ''}"
                    >
                        <p class="text-xs text-muted-foreground">
                            {item.label}
                        </p>
                        <p
                            class="mt-1 text-xl font-semibold tabular-nums"
                        >
                            {item.value}
                        </p>
                        <p
                            class="mt-0.5 text-xs {item.tone ===
                            'error'
                                ? 'text-destructive-foreground'
                                : item.tone === 'warning'
                                  ? 'text-warning-foreground'
                                  : 'text-muted-foreground'}"
                        >
                            {item.detail}
                        </p>
                    </div>
                {/each}
            </div>{/if}
        <div
            class={embedded
                ? layout.current === "grid"
                    ? "grid gap-4 @2xl:grid-cols-2"
                    : "grid gap-4"
                : "grid gap-4 lg:grid-cols-2"}
        >
            {#each charts as chart (chart.title)}{@render chartFrame(
                    chart,
                )}{/each}
            {#if httpStatus === "ok"}{#each httpCharts as chart (chart.title)}{@render chartFrame(
                        chart,
                    )}{/each}{/if}
            {#if databaseCollecting}{#each databaseCharts as chart (chart.title)}{@render chartFrame(
                        chart,
                    )}{/each}{/if}
        </div>
        {#if pendingEngine?.planned}
            <Alert variant="info">
                <AlertDescription>
                    {pendingEngine.label} metrics appear once its
                    {pendingEngine.exporter} resource is deployed and running.
                </AlertDescription>
            </Alert>
        {:else if pendingEngine}
            <AddDatabaseMetrics
                {projectId}
                {resourceId}
                label={pendingEngine.label}
            />
        {/if}
        {#if engine && database[0]?.isError}
            <Alert variant="error">
                <AlertDescription>
                    Could not load {engine.label} metrics: {database[0]
                        .error?.message}
                </AlertDescription>
            </Alert>
        {/if}
        {#if engine && database[0]?.isSuccess && !databaseCollecting}
            <Alert variant="info">
                <AlertDescription>
                    No database metrics yet. They appear once
                    monitoring scrapes the {engine.exporter} service; clusters
                    initialized before database metrics were added need
                    monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
        {#if httpStatus === "not-collecting"}
            <Alert variant="info">
                <AlertDescription>
                    No HTTP traffic recorded yet. Request metrics
                    appear after the first proxied request; clusters
                    initialized before Caddy metrics were added need
                    monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
        {#if !embedded}<ServicesTable data={rows} expandAll />{/if}
        <p class="text-xs text-muted-foreground" role="status">
            One line per service, all containers combined · 100% CPU =
            one core · dotted lines mark deployments · dashed latency
            lines are p99 · HTTP metrics cover ingress hostnames ·
            {#if selectedTime}
                <a
                    class="font-medium text-foreground underline underline-offset-4"
                    href={logsHref(
                        selectedTime - 300_000,
                        selectedTime + 300_000,
                    )}
                >
                    View logs around {clock(selectedTime)}
                </a>
            {:else}
                click a point on any chart to jump to the logs around
                that time
            {/if}
        </p>
    {/if}
</div>
