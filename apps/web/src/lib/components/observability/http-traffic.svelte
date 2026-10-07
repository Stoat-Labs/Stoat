<script lang="ts">
    import { browser } from "$app/environment";
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
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
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        seriesColor,
        type ChartSeries,
    } from "$lib/observability";
    import { orpc } from "$lib/orpc";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import {
        httpMetricNames,
        type HttpMetricName,
    } from "@stoat/api/observability";
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

    const range = useObservabilityRange();

    syncMetricCharts();

    const filters = useQueryStates(
        {
            clusters: parseAsArrayOf(parseAsString),
            paused: parseAsBoolean.withDefault(false),
        },
        { shallow: true, scroll: false },
    );

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

    const options = $derived({
        enabled: browser,
        refetchInterval:
            filters.paused.current || range.custom
                ? (false as const)
                : 30_000,
        retry: false,
        staleTime: 25_000,
    });

    // Without serviceIds the API charts every service that has an ingress hostname.
    const queries = createQueries(() => ({
        queries: selection.flatMap((cluster) =>
            httpMetricNames.map((name) =>
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

    const services = createQueries(() => ({
        queries: selection.map((cluster) =>
            orpc.cluster.getObservabilityServices.queryOptions({
                input: { clusterId: cluster.id },
                ...options,
            }),
        ),
    }));

    // Series only carry a service ID; resolve it to the name users recognise.
    const serviceNames = $derived(
        new Map(
            services.flatMap((query) =>
                (query.data ?? []).map((service) => [
                    service.id,
                    service.name,
                ]),
            ),
        ),
    );

    function query(clusterIndex: number, name: HttpMetricName) {
        return queries[
            clusterIndex * httpMetricNames.length +
                httpMetricNames.indexOf(name)
        ];
    }

    function chart(name: HttpMetricName): ChartSeries[] {
        return selection.flatMap((cluster, index) =>
            (query(index, name)?.data?.series ?? []).map((series) => {
                const service =
                    serviceNames.get(series.serviceId) ??
                    series.serviceId;

                return {
                    key: `${cluster.id}:${name}:${series.serviceId}`,
                    machineKey: `${cluster.id}:${series.serviceId}`,
                    label:
                        selection.length > 1
                            ? `${cluster.name} / ${service}`
                            : service,
                    color: seriesColor(service),
                    points: series.points,
                };
            }),
        );
    }

    const loaded = $derived(
        queries.flatMap((item) => (item.data ? [item.data] : [])),
    );

    const start = $derived(
        Math.min(...loaded.map((item) => item.start), Infinity),
    );

    const end = $derived(
        Math.max(...loaded.map((item) => item.end), 0),
    );

    // Each cluster reports one status for all its HTTP metrics; requests is representative.
    const statuses = $derived(
        selection.map((cluster, index) => ({
            cluster,
            status: query(index, "httpRequests")?.data?.status,
            error: query(index, "httpRequests")?.error,
        })),
    );

    const charting = $derived(
        statuses.some((item) => item.status === "ok"),
    );

    const fetching = $derived(
        queries.some((item) => item.isFetching),
    );

    // Show the skeleton only for the initial request; refetches keep the charts mounted.
    const pending = $derived(
        list.isPending ||
            (!loaded.length &&
                queries.some((item) => item.isPending)),
    );

    let hovered = $state("");

    const charts = $derived([
        {
            title: "Requests per second",
            series: chart("httpRequests"),
            unit: "requests" as const,
        },
        {
            title: "5xx errors per second",
            series: chart("httpErrors"),
            unit: "requests" as const,
        },
        {
            title: "P95 latency",
            series: chart("httpLatency"),
            unit: "duration" as const,
        },
        {
            title: "P50 / P99 latency",
            series: [
                ...chart("httpLatencyP50"),
                ...chart("httpLatencyP99").map((item) => ({
                    ...item,
                    label: `${item.label} p99`,
                    dashed: true,
                })),
            ],
            unit: "duration" as const,
        },
    ]);

    const legend = $derived(
        chart("httpRequests").filter((item) => item.points.length),
    );

    function toggleCluster(id: string) {
        void filters.set({
            clusters: selected.includes(id)
                ? selected.filter((item) => item !== id)
                : [...selected, id],
        });
    }

    useHeaderActions(toolbar);
</script>

<svelte:head>
    <title>HTTP traffic · Observability · Stoat</title>
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
                            checked={selected.includes(cluster.id)}
                            onCheckedChange={() =>
                                toggleCluster(cluster.id)}
                        />
                        <span class="truncate">{cluster.name}</span>
                    </label>
                {/each}
            </PopoverContent>
        </Popover>
        <RangeControls
            {range}
            bind:paused={filters.paused.current}
            disabled={!selection.length}
            {fetching}
            onrefresh={() =>
                queries.forEach((item) => void item.refetch())}
        />
    </div>
{/snippet}

<div class="min-w-0 w-full space-y-4 py-4 sm:space-y-6 sm:py-6">
    <div>
        <h1 class="text-2xl font-semibold">HTTP traffic</h1>
        <p class="mt-1 text-sm text-muted-foreground">
            Requests and latency recorded from ingress access logs.
        </p>
    </div>
    {#if list.isError}
        <Alert variant="error">
            <AlertDescription>
                Could not load clusters. <button
                    class="underline"
                    onclick={() => list.refetch()}
                >
                    Try again
                </button>
            </AlertDescription>
        </Alert>
    {/if}
    {#each statuses as { cluster, status, error } (cluster.id)}
        {#if error}
            <Alert variant="warning">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    {error.message}
                    <a
                        class="underline underline-offset-2"
                        href={`/clusters/${cluster.id}`}
                    >
                        Open cluster
                    </a>
                </AlertDescription>
            </Alert>
        {:else if status === "no-routes"}
            <Alert variant="info">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    No services have an HTTP or HTTPS ingress hostname yet.
                    Add a domain to a service to record its traffic.
                </AlertDescription>
            </Alert>
        {:else if status === "not-collecting"}
            <Alert variant="info">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    No HTTP traffic recorded yet. Request metrics appear
                    after the first proxied request; clusters initialized
                    before HTTP metrics were added need monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
    {/each}
    {#if pending}
        <Skeleton loading loading-label="Loading HTTP traffic">
            <div class="grid gap-4 lg:grid-cols-2">
                {#each charts as item (item.title)}<Frame>
                        <FrameHeader>
                            <FrameTitle>{item.title}</FrameTitle>
                        </FrameHeader><FramePanel class="p-4">
                            <div class="h-40 sm:h-48">
                                Loading chart
                            </div>
                        </FramePanel>
                    </Frame>{/each}
            </div>
        </Skeleton>
    {:else if !selection.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    {clusters.length
                        ? "Select a cluster"
                        : "No clusters yet"}
                </EmptyTitle><EmptyDescription>
                    {clusters.length
                        ? "Choose a cluster to inspect ingress traffic."
                        : "Create a cluster and initialize monitoring to record ingress traffic."}
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else if charting}
        <div class="grid gap-4 lg:grid-cols-2">
            {#each charts as item (item.title)}<Frame class="min-w-0">
                    <FrameHeader>
                        <FrameTitle>{item.title}</FrameTitle>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={item.series}
                            {start}
                            {end}
                            unit={item.unit}
                            bind:hoveredMachine={hovered}
                        />
                    </FramePanel>
                </Frame>{/each}
        </div>
        {#if legend.length}
            <div class="flex flex-wrap gap-x-4 gap-y-2">
                {#each legend as item (item.key)}<button
                        type="button"
                        class="flex items-center gap-2 text-xs"
                        style:opacity={hovered &&
                        hovered !== item.machineKey
                            ? 0.4
                            : 1}
                        onmouseenter={() =>
                            (hovered = item.machineKey ?? "")}
                        onmouseleave={() => (hovered = "")}
                        onfocus={() =>
                            (hovered = item.machineKey ?? "")}
                        onblur={() => (hovered = "")}
                    >
                        <span
                            class="size-2 rounded-full"
                            style:background={item.color}
                            aria-hidden="true"
                        ></span>
                        {item.label}
                    </button>{/each}
            </div>
        {/if}
        <p class="text-xs text-muted-foreground">
            Only services with HTTP/HTTPS ingress hostnames are
            recorded. Dashed latency lines are P99.
        </p>
    {/if}
</div>
