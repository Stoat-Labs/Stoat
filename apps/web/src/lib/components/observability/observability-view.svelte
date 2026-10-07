<script lang="ts">
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import { browser } from "$app/environment";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import Filesystems from "$lib/components/observability/filesystems.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import ScrapeTimeline from "$lib/components/observability/scrape-timeline.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import ServicesTable from "$lib/components/observability/services-table.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Checkbox } from "$lib/components/ui/checkbox";
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
    import {
        Popover,
        PopoverContent,
        PopoverTrigger,
    } from "$lib/components/ui/popover";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        assembleCluster,
        bandwidth,
        bytes,
        chartSeries,
        chartSeriesRatio,
        filesystemRows,
        metric,
        sumPoints,
        machineList,
        machineValue,
        percent,
        requests,
        rankCpu,
        rankMemory,
        rankTraffic,
        serviceRows,
        serviceSeries,
        sumMachines,
        topServices,
        type ClusterData,
    } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import {
        observabilityMetrics,
        observabilityViews,
        type ObservabilityView,
    } from "$lib/observability/navigation";
    import {
        counterCount,
        counterPercent,
        counterTotal,
    } from "$lib/observability/counters";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsArrayOf,
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";

    const { view }: { view: ObservabilityView } = $props();

    const title = $derived(
        observabilityViews.find((item) => item.id === view)?.title,
    );

    const filters = useQueryStates(
        {
            clusters: parseAsArrayOf(parseAsString),
            machine: parseAsString.withDefault(""),
            q: parseAsString.withDefault(""),
            paused: parseAsBoolean.withDefault(false),
        },
        { shallow: true, scroll: false },
    );

    const range = useObservabilityRange();

    syncMetricCharts();

    const machineMetricNames = $derived(observabilityMetrics(view));

    const loadingTitles = {
        overview: [
            "CPU per machine",
            "Memory by machine",
            "Disk usage · all filesystems",
            "Network · receive / send",
            "Disk I/O · read / write",
        ],
        dns: ["DNS queries", "DNS collection"],
        services: [
            "CPU by service",
            "Memory by service",
            "Network by service",
            "Services",
        ],
        health: ["Uncloud scrape health"],
        registry: [
            "Proxy requests",
            "Proxy hit percentage",
            "Upstream fetches (cache misses)",
            "Transfer · upstream / clients",
        ],
        // HTTP traffic renders its own page (http-traffic.svelte), never this view.
        http: [],
    } satisfies Record<ObservabilityView, string[]>;

    let hoveredMachine = $state("");

    const list = createQuery(() =>
        orpc.cluster.listObservableClusters.queryOptions({
            enabled: browser,
        }),
    );

    const clusters = $derived(list.data ?? []);

    const selected = $derived(
        filters.clusters.current ??
            (clusters[0] ? [clusters[0].id] : []),
    );

    const selection = $derived(
        clusters.filter((cluster) => selected.includes(cluster.id)),
    );

    // Live refresh only makes sense for ranges ending now; a custom range is a fixed window.
    const options = $derived({
        enabled: browser,
        refetchInterval:
            filters.paused.current || range.custom
                ? (false as const)
                : 30_000,
        retry: false,
        staleTime: 25_000,
    });

    const machineQueries = createQueries(() => ({
        queries: selection.map((cluster) =>
            orpc.cluster.getObservabilityMachines.queryOptions({
                input: { clusterId: cluster.id },
                ...options,
            }),
        ),
    }));

    const serviceQueries = createQueries(() => ({
        queries: selection.map((cluster) =>
            orpc.cluster.getObservabilityServices.queryOptions({
                input: { clusterId: cluster.id },
                ...options,
                enabled: options.enabled && view === "services",
            }),
        ),
    }));

    // One query per metric so each chart renders as soon as its own data arrives.
    const metricQueries = createQueries(() => ({
        queries: selection.flatMap((cluster) =>
            machineMetricNames.map((name) =>
                orpc.cluster.getObservabilityMetric.queryOptions({
                    input: {
                        clusterId: cluster.id,
                        name,
                        range: range.value,
                    },
                    ...options,
                }),
            ),
        ),
    }));

    const queries = $derived([
        ...machineQueries,
        ...(view === "services" ? serviceQueries : []),
        ...metricQueries,
    ]);

    // Background refetches settle one query at a time; recomputing every chart per response makes the page stutter,
    // so keep the previous result until the refresh finishes. New keys (range or cluster changes) still fill in progressively.
    const refetching = $derived(
        queries.some((query) => query.isFetching && !query.isPending),
    );

    let heldData: ClusterData[] = [];

    const data = $derived.by(() => {
        if (refetching && heldData.length) return heldData;

        heldData = selection.flatMap(
            (cluster, index): ClusterData[] => {
                const machines = machineQueries[index];
                const services = serviceQueries[index];

                return machines && services
                    ? [
                          assembleCluster(
                              cluster,
                              machines,
                              services,
                              metricQueries.slice(
                                  index * machineMetricNames.length,
                                  (index + 1) *
                                      machineMetricNames.length,
                              ),
                              machineMetricNames,
                          ),
                      ]
                    : [];
            },
        );

        return heldData;
    });

    const machines = $derived(machineList(data));

    const visibleMachines = $derived(
        machines.filter(
            (machine) =>
                !filters.machine.current ||
                machine.key === filters.machine.current,
        ),
    );

    const dnsSeries = $derived(
        chartSeries(visibleMachines, "dnsQueries"),
    );

    const dnsErrorSeries = $derived(
        chartSeries(visibleMachines, "dnsErrors"),
    );

    const scrapeSeries = $derived(
        chartSeries(visibleMachines, "dnsAvailability"),
    );

    const dnsPending = $derived(
        metricQueries.some(
            (query, index) =>
                machineMetricNames[
                    index % machineMetricNames.length
                ] === "dnsQueries" && query.isPending,
        ),
    );

    const dnsTotal = $derived(
        counterTotal(visibleMachines, "dnsQueries"),
    );

    const dnsErrors = $derived(
        counterTotal(visibleMachines, "dnsErrors"),
    );

    const dnsFailedPercentage = $derived(
        counterPercent(dnsErrors, dnsTotal),
    );

    const scrapePending = $derived(
        metricQueries.some(
            (query, index) =>
                machineMetricNames[
                    index % machineMetricNames.length
                ] === "dnsAvailability" && query.isPending,
        ),
    );

    const scrapeStep = $derived(
        Math.min(
            ...data.flatMap((cluster) =>
                cluster.available ? [cluster.step] : [],
            ),
        ),
    );

    const services = $derived(
        serviceRows(data, filters.machine.current),
    );

    const machineOptions = $derived([
        { value: "", label: "All machines" },
        ...machines.map((machine) => ({
            value: machine.key,
            label: `${machine.cluster.name} / ${machine.name}`,
        })),
    ]);

    // Show the skeleton only for the initial request; refetches keep the charts mounted.
    const pending = $derived(
        !data.some((cluster) => cluster.available) &&
            queries.some((query) => query.isPending),
    );

    const fetching = $derived(
        queries.some((query) => query.isFetching),
    );

    const start = $derived(
        Math.min(...data.map((cluster) => cluster.start), Infinity),
    );

    const end = $derived(
        Math.max(...data.map((cluster) => cluster.end), 0),
    );

    const dnsAverage = $derived(
        dnsTotal !== null && end > start
            ? dnsTotal / (end - start)
            : null,
    );

    const memory = $derived(sumMachines(visibleMachines, "memory"));

    const cores = $derived(sumMachines(visibleMachines, "cores"));

    const memoryTotal = $derived(
        sumMachines(visibleMachines, "memoryTotal"),
    );

    const disk = $derived(sumMachines(visibleMachines, "disk"));

    const diskTotal = $derived(
        sumMachines(visibleMachines, "diskTotal"),
    );

    const filesystems = $derived(filesystemRows(visibleMachines));

    const filesystemsPending = $derived(
        metricQueries.some(
            (query, index) =>
                ["filesystemUsed", "filesystemTotal"].includes(
                    machineMetricNames[
                        index % machineMetricNames.length
                    ],
                ) && query.isPending,
        ),
    );

    let hoveredService = $state("");

    const registryCharts = $derived([
        {
            title: "Proxy requests",
            series: chartSeries(
                visibleMachines,
                "registryProxyRequests",
            ),
            unit: "requests" as const,
        },
        {
            title: "Proxy hit percentage",
            series: chartSeriesRatio(
                visibleMachines,
                "registryProxyHits",
                "registryProxyRequests",
            ),
            unit: "percent" as const,
        },
        {
            title: "Upstream fetches (cache misses)",
            series: chartSeries(
                visibleMachines,
                "registryProxyMisses",
            ),
            unit: "requests" as const,
        },
        {
            title: "Transfer · upstream / clients",
            series: [
                ...chartSeries(
                    visibleMachines,
                    "registryProxyPulledBytes",
                ).map((item) => ({
                    ...item,
                    label: `${item.label} upstream`,
                })),
                ...chartSeries(
                    visibleMachines,
                    "registryProxyPushedBytes",
                ).map((item) => ({
                    ...item,
                    label: `${item.label} clients`,
                    dashed: true,
                })),
            ],
            unit: "rate" as const,
        },
        {
            title: "Storage-cache requests",
            series: chartSeries(
                visibleMachines,
                "registryCacheRequests",
            ),
            unit: "requests" as const,
        },
        {
            title: "Storage-cache hit percentage",
            series: chartSeriesRatio(
                visibleMachines,
                "registryCacheHits",
                "registryCacheRequests",
            ),
            unit: "percent" as const,
        },
        {
            title: "Storage-cache errors",
            series: chartSeries(
                visibleMachines,
                "registryCacheErrors",
            ),
            unit: "requests" as const,
        },
    ]);

    const registryTotals = $derived({
        proxyRequests: counterTotal(
            visibleMachines,
            "registryProxyRequests",
        ),
        proxyHits: counterTotal(visibleMachines, "registryProxyHits"),
        pulled: counterTotal(
            visibleMachines,
            "registryProxyPulledBytes",
        ),
        pushed: counterTotal(
            visibleMachines,
            "registryProxyPushedBytes",
        ),
        cacheErrors: counterTotal(
            visibleMachines,
            "registryCacheErrors",
        ),
    });

    const registryCards = $derived([
        [
            "Proxy requests",
            counterCount(registryTotals.proxyRequests),
        ],
        [
            "Proxy hit rate",
            percent(
                counterPercent(
                    registryTotals.proxyHits,
                    registryTotals.proxyRequests,
                ),
            ),
        ],
        ["Pulled from upstream", bytes(registryTotals.pulled)],
        ["Served to clients", bytes(registryTotals.pushed)],
        [
            "Storage-cache errors",
            counterCount(registryTotals.cacheErrors),
        ],
    ]);

    // Registry series only exist once the registry has served at least one request.
    const registryReporting = $derived(
        registryCharts.some((chart) =>
            chart.series.some((item) =>
                item.points.some((point) => point.value !== null),
            ),
        ),
    );

    const serviceNames = [
        "serviceCpu",
        "serviceMemory",
        "serviceNetworkIn",
        "serviceNetworkOut",
    ] as const;

    // The table's queries only carry the latest sample (and a coarse CPU sparkline), so fetch full history for the charted services only.
    const chartedIds = $derived(
        selection.map((cluster) =>
            [
                ...new Set(
                    [rankCpu, rankMemory, rankTraffic].flatMap(
                        (rank) =>
                            topServices(services, rank).flatMap(
                                (row) =>
                                    row.clusterId === cluster.id
                                        ? [row.id]
                                        : [],
                            ),
                    ),
                ),
            ].toSorted(),
        ),
    );

    const chartQueries = createQueries(() => ({
        queries: (view === "services" ? selection : []).flatMap(
            (cluster, index) =>
                serviceNames.map((name) =>
                    orpc.cluster.getObservabilityMetric.queryOptions({
                        input: {
                            clusterId: cluster.id,
                            name,
                            range: range.value,
                            serviceIds: chartedIds[index] ?? [],
                        },
                        ...options,
                        enabled:
                            options.enabled &&
                            Boolean(chartedIds[index]?.length),
                    }),
                ),
        ),
    }));

    const chartsPending = $derived(
        chartQueries.some(
            (query, index) =>
                chartedIds[Math.floor(index / serviceNames.length)]
                    ?.length && query.isPending,
        ),
    );

    const chartsRefetching = $derived(
        refetching ||
            chartQueries.some(
                (query) => query.isFetching && !query.isPending,
            ),
    );

    let heldChartData: ClusterData[] = [];

    const chartData = $derived.by(() => {
        if (chartsRefetching && heldChartData.length)
            return heldChartData;

        heldChartData = selection.flatMap(
            (cluster, index): ClusterData[] => {
                const machines = machineQueries[index];
                const services = serviceQueries[index];

                return machines && services
                    ? [
                          assembleCluster(
                              cluster,
                              machines,
                              services,
                              chartQueries.slice(
                                  index * serviceNames.length,
                                  (index + 1) * serviceNames.length,
                              ),
                              serviceNames,
                          ),
                      ]
                    : [];
            },
        );

        return heldChartData;
    });

    const nextServiceCharts = $derived([
        {
            title: "CPU by service",
            unit: "percent" as const,
            series: serviceSeries(
                chartData,
                services,
                ["serviceCpu"],
                rankCpu,
            ),
            note: "Top 5 by current CPU · 100% = one core",
        },
        {
            title: "Memory by service",
            unit: "bytes" as const,
            series: serviceSeries(
                chartData,
                services,
                ["serviceMemory"],
                rankMemory,
            ),
            note: "Top 5 by current memory",
        },
        {
            title: "Network by service",
            unit: "rate" as const,
            series: serviceSeries(
                chartData,
                services,
                ["serviceNetworkIn", "serviceNetworkOut"],
                rankTraffic,
            ),
            note: "Top 5 by current traffic · solid: receive · dashed: send",
        },
    ]);

    // createQueries cannot keep previous data when the top-service IDs change.
    // Retain the lines and their legends together until the new history is ready.
    const chartScope = $derived(
        JSON.stringify([
            selected,
            filters.machine.current,
            range.value,
        ]),
    );

    const showServiceSkeleton = $derived(
        chartsPending &&
            nextServiceCharts.every(
                (chart) => chart.series.length === 0,
            ),
    );

    let heldServiceCharts:
        | {
              scope: string;
              charts: typeof nextServiceCharts;
          }
        | undefined;

    const serviceCharts = $derived.by(() => {
        if (chartsPending && heldServiceCharts?.scope === chartScope)
            return heldServiceCharts.charts;

        heldServiceCharts = {
            scope: chartScope,
            charts: nextServiceCharts,
        };

        return nextServiceCharts;
    });

    const reporting = $derived(
        visibleMachines.filter(
            (machine) => machineValue(machine, "cpu") !== null,
        ).length,
    );

    const pressure = $derived(
        visibleMachines
            .flatMap((machine) => {
                const ratio = (
                    used: "disk" | "memory",
                    total: "diskTotal" | "memoryTotal",
                ) => {
                    const value = machineValue(machine, used);
                    const capacity = machineValue(machine, total);

                    return value !== null && capacity
                        ? (100 * value) / capacity
                        : null;
                };

                const memory = ratio("memory", "memoryTotal");
                const label = `${machine.cluster.name} / ${machine.name}`;

                return memory !== null && memory >= 90
                    ? [
                          {
                              key: `${machine.key}:memory`,
                              text: `${label}: memory ${percent(memory)} used`,
                              critical: memory >= 97,
                          },
                      ]
                    : [];
            })
            .concat(
                filesystems.flatMap((row) =>
                    row.percent !== null && row.percent >= 85
                        ? [
                              {
                                  key: row.key,
                                  text: `${row.label}: disk ${percent(row.percent)} full`,
                                  critical: row.percent >= 95,
                              },
                          ]
                        : [],
                ),
            ),
    );

    useHeaderActions(toolbar);

    function toggleCluster(id: string) {
        void filters.set({
            clusters: selected.includes(id)
                ? selected.filter((item) => item !== id)
                : [...selected, id],
            machine: "",
        });
    }
</script>

<svelte:head>
    <title>{title} · Observability · Stoat</title>
</svelte:head>

{#snippet toolbar()}
    <div
        class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"
    >
        <Popover>
            <PopoverTrigger
                class={buttonVariants({
                    variant: "outline",
                    size: "sm",
                })}
                disabled={list.isPending}
            >
                Clusters: {selection.length === 1
                    ? selection[0].name
                    : `${selection.length} selected`}<ChevronDown
                    class="ml-2 size-4"
                />
            </PopoverTrigger>
            <PopoverContent align="start" class="w-72 p-3">
                <div class="max-h-72 w-full space-y-1 overflow-auto">
                    <p
                        class="px-2 py-1 text-xs font-medium text-muted-foreground"
                    >
                        Select clusters
                    </p>
                    {#each clusters as cluster (cluster.id)}
                        <label
                            class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                        >
                            <Checkbox
                                checked={selected.includes(
                                    cluster.id,
                                )}
                                onCheckedChange={() =>
                                    toggleCluster(cluster.id)}
                            />
                            <span class="truncate">
                                {cluster.name}
                            </span>
                        </label>
                    {/each}
                </div>
            </PopoverContent>
        </Popover>
        <Select
            value={filters.machine.current}
            items={machineOptions}
            onValueChange={(value) => {
                filters.machine.current = value ?? "";
            }}
        >
            <SelectTrigger
                aria-label="Filter by machine"
                class="w-full sm:w-52"
            >
                <SelectValue placeholder="All machines" />
            </SelectTrigger>
            <SelectContent>
                {#each machineOptions as option (option.value)}<SelectItem
                        value={option.value}
                        label={option.label}
                    />{/each}
            </SelectContent>
        </Select>
        <RangeControls
            {range}
            bind:paused={filters.paused.current}
            fetching={fetching ||
                chartQueries.some((query) => query.isFetching)}
            disabled={!selection.length}
            onrefresh={() => {
                for (const query of [...queries, ...chartQueries])
                    void query.refetch();
            }}
        />
    </div>
{/snippet}

<div
    class="min-w-0 w-full space-y-4 overflow-x-clip pt-4 sm:space-y-6 sm:pt-6"
>
    {#if list.isError}<Alert variant="error">
            <AlertDescription>
                Could not load clusters. <button
                    class="underline"
                    onclick={() => list.refetch()}
                >
                    Try again
                </button>
            </AlertDescription>
        </Alert>{/if}
    {#if list.isPending || pending}
        <Skeleton loading loading-label={`Loading ${title} metrics`}>
            <div class="grid gap-4 lg:grid-cols-2">
                {#each loadingTitles[view] as heading, index (heading)}
                    <Frame
                        class={index === 0
                            ? "min-w-0 lg:col-span-2"
                            : "min-w-0"}
                    >
                        <FrameHeader>
                            <FrameTitle>{heading}</FrameTitle>
                        </FrameHeader>
                        <FramePanel class="min-w-0 p-4">
                            <div class="h-40 min-w-0 w-full sm:h-48">
                                Loading chart
                            </div>
                        </FramePanel>
                    </Frame>
                {/each}
            </div>
        </Skeleton>
    {/if}
    {#each data as cluster (cluster.id)}
        {#if cluster.reason}
            <Alert variant="warning">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    {cluster.reason === "uninitialized"
                        ? "Initialize monitoring to collect metrics."
                        : "Monitoring is unreachable. Other clusters remain available."}
                    <a
                        class="underline underline-offset-2"
                        href={`/clusters/${cluster.id}`}
                    >
                        Open cluster
                    </a>
                </AlertDescription>
            </Alert>
        {:else if cluster.unavailable.length}
            <Alert variant="info">
                <AlertDescription>
                    {cluster.name}: some metrics are unavailable ({cluster.unavailable.join(
                        ", ",
                    )}). Available charts are shown below.
                </AlertDescription>
            </Alert>
        {/if}
    {/each}
    {#if view === "overview" && pressure.length}
        <Alert
            variant={pressure.some((item) => item.critical)
                ? "error"
                : "warning"}
        >
            <AlertDescription>
                <span class="font-medium">Resource pressure:</span>
                {pressure.map((item) => item.text).join(" · ")}
            </AlertDescription>
        </Alert>
    {/if}
    {#if !list.isPending && !selection.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    {clusters.length
                        ? "Select a cluster"
                        : "No clusters yet"}
                </EmptyTitle><EmptyDescription>
                    {clusters.length
                        ? "Choose one or more clusters to view their machines and services."
                        : "Add a cluster and initialize monitoring to see system usage."}
                </EmptyDescription>
            </EmptyHeader>
            <a
                class={buttonVariants({ variant: "outline" })}
                href="/clusters"
            >
                Open clusters
            </a>
        </Empty>
    {:else if data.some((cluster) => cluster.available)}
        {#if view === "overview"}
            <Frame>
                <FrameHeader
                    class="flex-row flex-wrap items-center justify-between gap-2"
                >
                    <FrameTitle>CPU per machine</FrameTitle>
                    <span
                        class="text-xs text-muted-foreground tabular-nums"
                    >
                        <span class="font-medium text-foreground">
                            {percent(
                                sumMachines(visibleMachines, "cpu"),
                            )}
                        </span>
                        of {percent(
                            cores === null ? null : cores * 100,
                        )}{reporting < visibleMachines.length
                            ? ` · ${reporting} / ${visibleMachines.length} reporting`
                            : ""}
                    </span>
                </FrameHeader>
                <FramePanel class="min-w-0 p-4">
                    <MetricChart
                        series={chartSeries(visibleMachines, "cpu")}
                        {start}
                        {end}
                        bind:hoveredMachine
                    />
                    <div class="mt-3 flex flex-wrap gap-2">
                        {#each machines as machine (machine.key)}
                            <Button
                                variant={filters.machine.current ===
                                machine.key
                                    ? "secondary"
                                    : "ghost"}
                                size="sm"
                                class="gap-2 text-xs"
                                style={`opacity: ${hoveredMachine && hoveredMachine !== machine.key ? 0.4 : 1}`}
                                onpointerenter={() =>
                                    (hoveredMachine = machine.key)}
                                onpointerleave={() =>
                                    (hoveredMachine = "")}
                                onfocus={() =>
                                    (hoveredMachine = machine.key)}
                                onblur={() => (hoveredMachine = "")}
                                aria-pressed={filters.machine
                                    .current === machine.key}
                                onclick={() =>
                                    (filters.machine.current =
                                        filters.machine.current ===
                                        machine.key
                                            ? ""
                                            : machine.key)}
                            >
                                <span
                                    class="size-2 rounded-full"
                                    style:background={machine.color}
                                ></span>
                                {machine.cluster.name} / {machine.name}
                                <span
                                    class="font-semibold tabular-nums"
                                >
                                    {percent(
                                        machineValue(machine, "cpu"),
                                    )}
                                </span>
                            </Button>
                        {/each}
                    </div>
                </FramePanel>
            </Frame>

            <div class="grid gap-4 lg:grid-cols-2">
                <Frame class="min-w-0">
                    <FrameHeader
                        class="flex-row flex-wrap items-center justify-between gap-2"
                    >
                        <FrameTitle>Memory by machine</FrameTitle>
                        <span
                            class="text-xs text-muted-foreground tabular-nums"
                        >
                            <span class="font-medium text-foreground">
                                {bytes(memory)}
                            </span>
                            of {bytes(memoryTotal)}
                        </span>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={chartSeries(
                                visibleMachines,
                                "memory",
                            )}
                            {start}
                            {end}
                            unit="bytes"
                            bind:hoveredMachine
                        />
                        <div
                            class="mt-3 flex flex-wrap gap-x-4 gap-y-2"
                        >
                            {#each visibleMachines as machine (machine.key)}<span
                                    class="flex items-center gap-2 text-xs"
                                    style:opacity={hoveredMachine &&
                                    hoveredMachine !== machine.key
                                        ? 0.4
                                        : 1}
                                >
                                    <span
                                        class="size-2 rounded-full"
                                        style:background={machine.color}
                                    ></span>
                                    {machine.cluster.name} / {machine.name}
                                </span>{/each}
                        </div>
                    </FramePanel>
                </Frame>
                <Frame class="min-w-0">
                    <FrameHeader
                        class="flex-row flex-wrap items-center justify-between gap-2"
                    >
                        <FrameTitle>
                            Disk usage · all filesystems
                        </FrameTitle>
                        <span
                            class="text-xs text-muted-foreground tabular-nums"
                        >
                            <span class="font-medium text-foreground">
                                {disk !== null && diskTotal
                                    ? percent(
                                          (100 * disk) / diskTotal,
                                      )
                                    : "—"}
                            </span>
                            · {bytes(disk)} of {bytes(diskTotal)}
                        </span>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={chartSeriesRatio(
                                visibleMachines,
                                "disk",
                                "diskTotal",
                            )}
                            {start}
                            {end}
                            max={100}
                            bind:hoveredMachine
                        />
                        <div
                            class="mt-3 flex flex-wrap gap-x-4 gap-y-2"
                        >
                            {#each visibleMachines as machine (machine.key)}<span
                                    class="flex items-center gap-2 text-xs"
                                    style:opacity={hoveredMachine &&
                                    hoveredMachine !== machine.key
                                        ? 0.4
                                        : 1}
                                >
                                    <span
                                        class="size-2 rounded-full"
                                        style:background={machine.color}
                                    ></span>
                                    {machine.cluster.name} / {machine.name}
                                </span>{/each}
                        </div>
                    </FramePanel>
                </Frame>
                <Frame class="min-w-0">
                    <FrameHeader
                        class="flex-row flex-wrap items-center justify-between gap-2"
                    >
                        <FrameTitle>
                            Network · receive / send
                        </FrameTitle>
                        <span
                            class="text-xs text-muted-foreground tabular-nums"
                        >
                            ↓ <span
                                class="font-medium text-foreground"
                            >
                                {bandwidth(
                                    sumMachines(
                                        visibleMachines,
                                        "networkIn",
                                    ),
                                )}
                            </span>
                            · ↑
                            <span class="font-medium text-foreground">
                                {bandwidth(
                                    sumMachines(
                                        visibleMachines,
                                        "networkOut",
                                    ),
                                )}
                            </span>
                        </span>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={[
                                ...chartSeries(
                                    visibleMachines,
                                    "networkIn",
                                ).map((item) => ({
                                    ...item,
                                    label: `${item.label} receive`,
                                })),
                                ...chartSeries(
                                    visibleMachines,
                                    "networkOut",
                                ).map((item) => ({
                                    ...item,
                                    label: `${item.label} send`,
                                })),
                            ]}
                            {start}
                            {end}
                            unit="rate"
                            bind:hoveredMachine
                        />
                        <p class="mt-2 text-xs text-muted-foreground">
                            Solid: receive · dashed: send · bits per
                            second
                        </p>
                    </FramePanel>
                </Frame>
                <Frame class="min-w-0">
                    <FrameHeader
                        class="flex-row flex-wrap items-center justify-between gap-2"
                    >
                        <FrameTitle>
                            Disk I/O · read / write
                        </FrameTitle>
                        <span
                            class="text-xs text-muted-foreground tabular-nums"
                        >
                            R <span
                                class="font-medium text-foreground"
                            >
                                {bandwidth(
                                    sumMachines(
                                        visibleMachines,
                                        "diskRead",
                                    ),
                                )}
                            </span>
                            · W
                            <span class="font-medium text-foreground">
                                {bandwidth(
                                    sumMachines(
                                        visibleMachines,
                                        "diskWrite",
                                    ),
                                )}
                            </span>
                        </span>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={[
                                ...chartSeries(
                                    visibleMachines,
                                    "diskRead",
                                ).map((item) => ({
                                    ...item,
                                    label: `${item.label} read`,
                                })),
                                ...chartSeries(
                                    visibleMachines,
                                    "diskWrite",
                                ).map((item) => ({
                                    ...item,
                                    label: `${item.label} write`,
                                })),
                            ]}
                            {start}
                            {end}
                            unit="rate"
                            bind:hoveredMachine
                        />
                        <p class="mt-2 text-xs text-muted-foreground">
                            Solid: read · dashed: write · bytes per
                            second
                        </p>
                    </FramePanel>
                </Frame>
            </div>

            <Filesystems
                rows={filesystems}
                {start}
                {end}
                loading={filesystemsPending}
                bind:hoveredMachine
            />
        {/if}

        {#if view === "dns"}
            <section
                class="min-w-0 space-y-3"
                aria-label="DNS metrics"
            >
                <h2 class="text-sm font-semibold">DNS</h2>
                <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {#each [["Total queries", counterCount(dnsTotal)], ["Average rate", requests(dnsAverage)], ["Failed queries", `${counterCount(dnsErrors)} · ${percent(dnsFailedPercentage)}`], ["Reporting machines", `${new Set(dnsSeries.map((item) => item.machineKey)).size}`]] as card (card[0])}
                        <Frame class="min-w-0">
                            <FrameHeader class="gap-1 py-3">
                                <FrameTitle
                                    class="text-xs text-muted-foreground"
                                >
                                    {card[0]}
                                </FrameTitle>
                                <p
                                    class="text-xl font-semibold tabular-nums"
                                >
                                    {card[1]}
                                </p>
                            </FrameHeader>
                        </Frame>
                    {/each}
                </div>
                <p class="text-xs text-muted-foreground">
                    Totals use the selected time range. Failed queries
                    are Uncloud requests recorded with status “err”;
                    scrape outages are shown under Collection health.
                </p>
                <Frame class="min-w-0 w-full">
                    <FrameHeader>
                        <FrameTitle>DNS queries</FrameTitle>
                    </FrameHeader>
                    <FramePanel class="min-w-0 p-4">
                        {#if dnsPending}
                            <Skeleton
                                loading
                                loading-label="Loading DNS queries"
                            >
                                <div class="h-40 sm:h-48">
                                    Loading chart
                                </div>
                            </Skeleton>
                        {:else}
                            <MetricChart
                                series={dnsSeries}
                                {start}
                                {end}
                                unit="requests"
                                bind:hoveredMachine
                            />
                            <div class="mt-6 border-t pt-4">
                                <p
                                    class="mb-2 text-xs font-medium text-muted-foreground"
                                >
                                    Failed query rate
                                </p>
                                <MetricChart
                                    series={dnsErrorSeries}
                                    {start}
                                    {end}
                                    unit="requests"
                                    bind:hoveredMachine
                                />
                            </div>
                            <div
                                class="mt-3 flex flex-wrap gap-x-4 gap-y-2"
                            >
                                {#each dnsSeries as series (series.key)}
                                    <span
                                        class="flex items-center gap-2 text-xs"
                                        style:opacity={hoveredMachine &&
                                        hoveredMachine !==
                                            series.machineKey
                                            ? 0.4
                                            : 1}
                                    >
                                        <span
                                            class="size-2 rounded-full"
                                            style:background={series.color}
                                        ></span>
                                        {series.label}
                                    </span>
                                {/each}
                            </div>
                        {/if}
                        <p class="mt-2 text-xs text-muted-foreground">
                            Queries per second · all statuses and
                            internal/external traffic
                        </p>
                    </FramePanel>
                </Frame>
            </section>
        {/if}

        {#if view === "services"}
            <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {#each serviceCharts as chart (chart.title)}
                    <Frame class="min-w-0">
                        <FrameHeader>
                            <FrameTitle>{chart.title}</FrameTitle>
                        </FrameHeader>
                        <FramePanel
                            class="flex min-w-0 flex-1 flex-col p-4"
                        >
                            {#if showServiceSkeleton}
                                <Skeleton
                                    loading
                                    loading-label="Loading service metrics"
                                >
                                    <div class="h-40 sm:h-48">
                                        Loading chart
                                    </div>
                                </Skeleton>
                            {:else}
                                <MetricChart
                                    series={chart.series}
                                    {start}
                                    {end}
                                    unit={chart.unit}
                                    bind:hoveredMachine={
                                        hoveredService
                                    }
                                />
                            {/if}
                            <div
                                class="mt-3 grid min-h-20 grid-cols-2 content-start gap-x-3 gap-y-1"
                                aria-label={`${chart.title} legend`}
                            >
                                {#each chart.series.filter((item) => !item.dashed) as item (item.key)}<button
                                        type="button"
                                        class="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        title={item.label}
                                        onpointerenter={() =>
                                            (hoveredService =
                                                item.machineKey ??
                                                "")}
                                        onpointerleave={() =>
                                            (hoveredService = "")}
                                        onfocus={() =>
                                            (hoveredService =
                                                item.machineKey ??
                                                "")}
                                        onblur={() =>
                                            (hoveredService = "")}
                                        style:opacity={hoveredService &&
                                        hoveredService !==
                                            item.machineKey
                                            ? 0.4
                                            : 1}
                                    >
                                        <span
                                            class="size-2 shrink-0 rounded-full"
                                            style:background={item.color}
                                            aria-hidden="true"
                                        ></span>
                                        <span class="truncate">
                                            {item.label}
                                        </span>
                                    </button>{/each}
                            </div>
                            <p
                                class="mt-auto min-h-10 pt-2 text-xs text-muted-foreground"
                            >
                                {chart.note}
                            </p>
                        </FramePanel>
                    </Frame>
                {/each}
            </div>
        {/if}

        {#if view === "registry"}
            {#if !registryReporting}
                <Frame>
                    <FrameHeader>
                        <FrameTitle>
                            No registry traffic recorded yet
                        </FrameTitle>
                    </FrameHeader>
                    <FramePanel
                        class="space-y-2 p-4 text-sm text-muted-foreground"
                    >
                        <p>
                            No registry requests were recorded in this
                            time range. Charts fill in after machines
                            pull images through the cluster registry.
                        </p>
                    </FramePanel>
                </Frame>
            {/if}
            <div
                class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
            >
                {#each registryCards as card (card[0])}
                    <Frame class="min-w-0">
                        <FrameHeader class="gap-1 py-3">
                            <FrameTitle
                                class="text-xs text-muted-foreground"
                            >
                                {card[0]}
                            </FrameTitle>
                            <p
                                class="text-xl font-semibold tabular-nums"
                            >
                                {card[1]}
                            </p>
                        </FrameHeader>
                    </Frame>
                {/each}
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
                {#each registryCharts as chart (chart.title)}
                    <Frame class="min-w-0">
                        <FrameHeader>
                            <FrameTitle>{chart.title}</FrameTitle>
                        </FrameHeader>
                        <FramePanel class="min-w-0 p-4">
                            <MetricChart
                                series={chart.series}
                                {start}
                                {end}
                                unit={chart.unit}
                            />
                        </FramePanel>
                    </Frame>
                {/each}
            </div>
            <p class="text-xs text-muted-foreground">
                Totals cover the selected time range. Proxy hits and
                misses describe registry content requests;
                storage-cache metrics describe metadata lookups.
                Pushed bytes means bytes served to clients.
            </p>
        {/if}
        {#if view === "services"}
            <ServicesTable
                data={services}
                {start}
                {end}
                bind:search={
                    () => filters.q.current,
                    (value) => (filters.q.current = value)
                }
            />
        {/if}
        {#if view === "health"}
            <section
                class="min-w-0 space-y-3"
                aria-label="Collection health"
            >
                <h2 class="text-sm font-semibold">
                    Collection health
                </h2>
                <Frame class="min-w-0 w-full">
                    <FrameHeader>
                        <FrameTitle>Uncloud scrape health</FrameTitle>
                    </FrameHeader>
                    <FramePanel class="min-w-0 p-4">
                        {#if scrapePending}
                            <Skeleton
                                loading
                                loading-label="Loading Uncloud scrape health"
                            >
                                <div class="h-40 sm:h-48">
                                    Loading timeline
                                </div>
                            </Skeleton>
                        {:else}
                            <ScrapeTimeline
                                series={scrapeSeries}
                                {start}
                                {end}
                                step={scrapeStep}
                            />
                        {/if}
                        <p class="mt-2 text-xs text-muted-foreground">
                            Each interval shows any recorded scrape
                            failure. Missing data is unknown, not
                            healthy. This is not DNS resolution
                            health.
                        </p>
                    </FramePanel>
                </Frame>
            </section>
        {/if}
        <p class="text-xs text-muted-foreground">
            Charts show the selected range; numbers show its latest
            sample. Gaps mean missing data. {pending ||
            data.some((cluster) => !cluster.available)
                ? "Totals include reporting clusters only."
                : ""}
        </p>
    {/if}
</div>
