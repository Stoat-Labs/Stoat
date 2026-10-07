<script lang="ts">
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import { browser } from "$app/environment";
    import { page } from "$app/state";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import ServicesTable from "$lib/components/observability/services-table.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
        percent,
        rankCpu,
        rankMemory,
        rankTraffic,
        serviceRows,
        serviceSeries,
    } from "$lib/observability";
    import { orpc } from "$lib/orpc";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const range = useObservabilityRange();

    syncMetricCharts();

    const names = [
        "serviceCpu",
        "serviceMemory",
        "serviceNetworkIn",
        "serviceNetworkOut",
    ] as const;

    const paused = useQueryState(
        "paused",
        parseAsBoolean.withDefault(false),
    );

    const project = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: browser && Boolean(projectId),
        }),
    );

    const clusterId = $derived(project.data?.clusterId ?? "");

    const options = $derived({
        enabled: browser && Boolean(clusterId),
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

    const serviceIds = $derived([
        ...new Set(
            (services.data ?? []).flatMap((service) =>
                service.href?.startsWith(`/projects/${projectId}/`)
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

    const cluster = $derived(
        assembleCluster(
            { id: clusterId, name: project.data?.name ?? "" },
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

    const total = (
        field: "cpu" | "memory" | "networkIn" | "networkOut",
    ) => rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);

    const charts = $derived([
        {
            title: "CPU",
            unit: "percent" as const,
            total: percent(total("cpu")),
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
            total: bytes(total("memory")),
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
            total: `↓ ${bandwidth(total("networkIn"))} · ↑ ${bandwidth(total("networkOut"))}`,
            series: serviceSeries(
                [cluster],
                rows,
                ["serviceNetworkIn", "serviceNetworkOut"],
                rankTraffic,
                rows.length,
            ),
        },
    ]);

    const pending = $derived(
        project.isPending ||
            services.isPending ||
            (serviceIds.length > 0 &&
                !cluster.available &&
                metrics.some((query) => query.isPending)),
    );

    const fetching = $derived(
        services.isFetching ||
            metrics.some((query) => query.isFetching),
    );

    useHeaderActions(toolbar);
</script>

<svelte:head>
    <title>
        {project.data?.name ?? "Project"} observability · Stoat
    </title>
</svelte:head>

{#snippet toolbar()}
    <RangeControls
        {range}
        bind:paused={paused.current}
        {fetching}
        disabled={!clusterId}
        onrefresh={() => {
            void services.refetch();
            for (const query of metrics) void query.refetch();
        }}
    />
{/snippet}

<div
    class="min-w-0 w-full space-y-4 overflow-x-clip pt-4 sm:space-y-6 sm:pt-6"
>
    {#if project.isError}<Alert variant="error">
            <AlertDescription>
                Could not load this project. <button
                    class="underline"
                    onclick={() => project.refetch()}
                >
                    Try again
                </button>
            </AlertDescription>
        </Alert>{/if}
    {#if pending}
        <Skeleton
            loading
            loading-label="Loading project observability"
        >
            <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {#each charts as chart (chart.title)}<Frame>
                        <FrameHeader>
                            <FrameTitle>{chart.title}</FrameTitle>
                        </FrameHeader><FramePanel>
                            <div class="h-40 sm:h-48">
                                Loading chart
                            </div>
                        </FramePanel>
                    </Frame>{/each}
            </div>
        </Skeleton>
    {:else if !serviceIds.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    No running services
                </EmptyTitle><EmptyDescription>
                    Deploy a resource in this project to start
                    collecting metrics.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else if cluster.reason}
        <Alert variant="warning">
            <AlertDescription>
                {cluster.reason === "uninitialized"
                    ? "Initialize monitoring on this cluster to collect metrics."
                    : "Monitoring is unreachable."}
            </AlertDescription>
        </Alert>
    {:else if cluster.available}
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {#each charts as chart (chart.title)}<Frame
                    class="min-w-0"
                >
                    <FrameHeader
                        class="flex-row items-center justify-between gap-2"
                    >
                        <FrameTitle>{chart.title}</FrameTitle>
                        <span
                            class="text-xs font-medium tabular-nums"
                        >
                            {chart.total}
                        </span>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        <MetricChart
                            series={chart.series}
                            start={cluster.start}
                            end={cluster.end}
                            unit={chart.unit}
                        />
                        <div
                            class="mt-3 flex flex-wrap gap-x-4 gap-y-2"
                        >
                            {#each chart.series.filter((item) => !item.dashed) as item (item.key)}<span
                                    class="flex items-center gap-2 text-xs"
                                >
                                    <span
                                        class="size-2 rounded-full"
                                        style:background={item.color}
                                    ></span>
                                    {item.label}
                                </span>{/each}
                        </div>
                    </FramePanel>
                </Frame>{/each}
        </div>
        <ServicesTable
            data={rows}
            start={cluster.start}
            end={cluster.end}
            expandAll
        />
    {/if}
</div>
