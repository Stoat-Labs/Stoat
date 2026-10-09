<script lang="ts">
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import { browser } from "$app/environment";
    import DnsView from "$lib/components/observability/dns-view.svelte";
    import HealthView from "$lib/components/observability/health-view.svelte";
    import OverviewView from "$lib/components/observability/overview-view.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import ServicesView, {
        type ServiceChart,
    } from "$lib/components/observability/services-view.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
        machineList,
        rankCpu,
        rankMemory,
        rankTraffic,
        serviceRows,
        serviceSeries,
        topServices,
        type ClusterData,
    } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import {
        observabilityMetrics,
        observabilityViews,
        type ObservabilityView,
    } from "$lib/observability/navigation";
    import type { MachineMetricName } from "@stoat/api/observability";
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
        // HTTP traffic renders its own page (http-traffic.svelte), never this view.
        http: [],
    } satisfies Record<ObservabilityView, string[]>;

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

    /** Whether the first response for any of these metrics is still loading. */
    function metricPending(names: MachineMetricName[]) {
        return metricQueries.some(
            (query, index) =>
                names.includes(
                    machineMetricNames[
                        index % machineMetricNames.length
                    ],
                ) && query.isPending,
        );
    }

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

    const nextServiceCharts: ServiceChart[] = $derived([
        {
            title: "CPU by service",
            unit: "percent",
            series: serviceSeries(
                chartData,
                services,
                ["serviceCpu"],
                rankCpu,
            ),
        },
        {
            title: "Memory by service",
            unit: "bytes",
            series: serviceSeries(
                chartData,
                services,
                ["serviceMemory"],
                rankMemory,
            ),
        },
        {
            title: "Network by service",
            unit: "rate",
            series: serviceSeries(
                chartData,
                services,
                ["serviceNetworkIn", "serviceNetworkOut"],
                rankTraffic,
            ),
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
        | { scope: string; charts: ServiceChart[] }
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
            <OverviewView
                {machines}
                {visibleMachines}
                {start}
                {end}
                filesystemsLoading={metricPending([
                    "filesystemUsed",
                    "filesystemTotal",
                ])}
                bind:machine={
                    () => filters.machine.current,
                    (value) => (filters.machine.current = value)
                }
            />
        {:else if view === "dns"}
            <DnsView
                {visibleMachines}
                {start}
                {end}
                loading={metricPending(["dnsQueries"])}
            />
        {:else if view === "services"}
            <ServicesView
                {services}
                charts={serviceCharts}
                loading={showServiceSkeleton}
                {start}
                {end}
                bind:search={
                    () => filters.q.current,
                    (value) => (filters.q.current = value)
                }
            />
        {:else if view === "health"}
            <HealthView
                {visibleMachines}
                {start}
                {end}
                step={scrapeStep}
                loading={metricPending(["dnsAvailability"])}
            />
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
