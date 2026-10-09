<script lang="ts">
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import { browser } from "$app/environment";
    import { page } from "$app/state";
    import { ago } from "$lib/format";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import ServicesTable from "$lib/components/observability/services-table.svelte";
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
        type ChartSeries,
        type MetricUnit,
    } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import { databaseEngine } from "@stoat/api/databases";
    import {
        httpMetricNames,
        postgresMetricNames,
        type MetricSeries,
    } from "@stoat/api/observability";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    const names = [
        "serviceCpu",
        "serviceMemory",
        "serviceNetworkIn",
        "serviceNetworkOut",
    ] as const;

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const range = useObservabilityRange();

    syncMetricCharts();

    const paused = useQueryState(
        "paused",
        parseAsBoolean.withDefault(false),
    );

    let hovered = $state("");

    let selectedTime = $state<number | null>(null);

    const project = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: browser && projectId.length > 0,
        }),
    );

    const clusterId = $derived(project.data?.clusterId ?? "");

    const resource = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: browser && projectId.length > 0 && resourceId.length > 0,
        }),
    );

    const isPostgres = $derived(
        !!resource.data &&
            databaseEngine(resource.data) === "postgresql",
    );

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
    const serviceIds = $derived([
        ...new Set(
            (services.data ?? []).flatMap((service) =>
                service.href ===
                `/projects/${projectId}/${resourceId}`
                    ? [service.id]
                    : [],
            ),
        ),
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
                ...options,
                enabled: options.enabled && serviceIds.length > 0,
            }),
        ),
    }));

    // The template's exporter service is one of this resource's services, so the same scope applies.
    const postgres = createQueries(() => ({
        queries: postgresMetricNames.map((name) =>
            orpc.cluster.getObservabilityMetric.queryOptions({
                input: {
                    clusterId,
                    name,
                    range: range.value,
                    serviceIds,
                },
                ...options,
                enabled:
                    options.enabled &&
                    isPostgres &&
                    serviceIds.length > 0,
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
            { id: clusterId, name: "" },
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
            title: "Network · receive / send",
            unit: "rate" as const,
            total: `↓ ${bandwidth(sum(rows.map((row) => row.networkIn)))} · ↑ ${bandwidth(sum(rows.map((row) => row.networkOut)))}`,
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceNetworkIn", "serviceNetworkOut"],
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
                title: "Latency · p50",
                unit: "duration" as const,
                series: httpSeries.latencyP50,
            },
            {
                title: "Latency · p95",
                unit: "duration" as const,
                series: httpSeries.latency,
            },
            {
                title: "Latency · p99",
                unit: "duration" as const,
                series: httpSeries.latencyP99,
            },
        ];
    });

    // One line per metric: a moved exporter leaves per-machine series that never overlap in time.
    const postgresPoints = $derived(
        Object.fromEntries(
            postgresMetricNames.map((name, index) => [
                name,
                sumPoints(
                    (postgres[index]?.data?.series ?? []).map(
                        (item) => item.points,
                    ),
                ),
            ]),
        ),
    );

    // `not-collecting` means no exporter was scraped yet; an empty result means not this one.
    const postgresCollecting = $derived(
        postgres[0]?.data?.status === "ok" &&
            postgresPoints.postgresConnections.length > 0,
    );

    const postgresLatest = (name: (typeof postgresMetricNames)[number]) =>
        current(postgresPoints[name], cluster.end, cluster.step);

    const postgresCharts = $derived(
        (
            [
                ["Connections", "count", "postgresConnections"],
                ["Transactions", "perSecond", "postgresTransactions"],
                ["Cache hit ratio", "percent", "postgresCacheHit"],
                ["Database size", "bytes", "postgresSize"],
            ] as const
        ).map(([title, unit, name]) => ({
            title,
            unit,
            total: { count, perSecond, percent, bytes }[unit](
                postgresLatest(name),
            ),
            series: [
                {
                    key: name,
                    machineKey: name,
                    label: "PostgreSQL",
                    color: "var(--chart-1)",
                    points: postgresPoints[name] ?? [],
                },
            ],
        })),
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
        const connections = postgresLatest("postgresConnections");
        const maxConnections = postgresLatest("postgresMaxConnections");

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
            ...(postgresCollecting
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
            [...metrics, ...http, ...postgres].some(
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

    useHeaderActions(toolbar);
</script>

<svelte:head><title>Metrics / Stoat</title></svelte:head>

{#snippet toolbar()}
    <div
        class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"
    >
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
        <RangeControls
            {range}
            bind:paused={paused.current}
            {fetching}
            disabled={!clusterId}
            onrefresh={() => {
                void services.refetch();
                for (const query of [...metrics, ...http, ...postgres])
                    void query.refetch();
            }}
        />
    </div>
{/snippet}

{#snippet chartFrame(chart: {
    title: string;
    unit: MetricUnit;
    total?: string;
    series: ChartSeries[];
})}
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
                bind:hoveredMachine={hovered}
                onselecttime={(time) => (selectedTime = time)}
            />
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                {#each chart.series.filter((item) => !item.dashed) as item (item.key)}<span
                        class="flex items-center gap-2 text-xs"
                        style:opacity={hovered &&
                        hovered !== item.machineKey
                            ? 0.4
                            : 1}
                    >
                        <span
                            class="size-2 rounded-full"
                            style:background={item.color}
                        ></span>
                        {item.label}
                    </span>{/each}
            </div>
        </FramePanel>
    </Frame>
{/snippet}

<div
    class="min-w-0 w-full space-y-4 overflow-x-clip pt-4 sm:space-y-6 sm:pt-6"
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
                {#each ["CPU", "Memory", "Network · receive / send"] as title (title)}<Frame
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
        <div
            class="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6"
        >
            {#each summary as item (item.label)}
                <div
                    class="rounded-lg border p-3 {item.tone ===
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
                        class="mt-0.5 text-xs {item.tone === 'error'
                            ? 'text-destructive-foreground'
                            : item.tone === 'warning'
                              ? 'text-warning-foreground'
                              : 'text-muted-foreground'}"
                    >
                        {item.detail}
                    </p>
                </div>
            {/each}
        </div>
        <div class="grid gap-4 lg:grid-cols-2">
            {#each charts as chart (chart.title)}{@render chartFrame(
                    chart,
                )}{/each}
            {#if httpStatus === "ok"}{#each httpCharts as chart (chart.title)}{@render chartFrame(
                        chart,
                    )}{/each}{/if}
            {#if postgresCollecting}{#each postgresCharts as chart (chart.title)}{@render chartFrame(
                        chart,
                    )}{/each}{/if}
        </div>
        {#if isPostgres && postgres[0]?.isSuccess && !postgresCollecting}
            <Alert variant="info">
                <AlertDescription>
                    No database metrics yet. Databases created before
                    metrics were added need the template's
                    <code>postgres-metrics</code> service in their
                    Compose file, and clusters initialized before then
                    need monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
        {#if httpStatus === "not-collecting"}
            <Alert variant="info">
                <AlertDescription>
                    No HTTP traffic recorded yet. Request metrics
                    appear after the first proxied request; clusters
                    initialized before HTTP metrics were added need
                    monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
        <ServicesTable
            data={rows}
            start={cluster.start}
            end={cluster.end}
            expandAll
        />
        <p class="text-xs text-muted-foreground" role="status">
            One line per service, all containers combined · 100% CPU =
            one core · dotted lines mark deployments · network: solid
            receive, dashed send · HTTP metrics cover ingress
            hostnames ·
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
