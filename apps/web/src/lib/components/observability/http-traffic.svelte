<script lang="ts">
    import { browser } from "$app/environment";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
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
    import { orpc } from "$lib/orpc";
    import { observabilityHref } from "$lib/observability-navigation";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsArrayOf,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";
    import { httpMetricNames } from "@stoat/api/observability";

    const range = useObservabilityRange();
    const filters = useQueryStates(
        { clusters: parseAsArrayOf(parseAsString) },
        { shallow: true, scroll: false },
    );
    let paused = $state(false);

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
            paused || range.custom ? (false as const) : 30_000,
        retry: false,
        staleTime: 25_000,
    });
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

    const chart = (name: (typeof httpMetricNames)[number]) =>
        selection.flatMap((cluster, clusterIndex) => {
            const query =
                queries[
                    clusterIndex * httpMetricNames.length +
                        httpMetricNames.indexOf(name)
                ];
            return (
                query?.data?.series.map((series) => ({
                    key: `${cluster.id}:${name}:${series.serviceId}:${series.container}`,
                    label: series.container || cluster.name,
                    color: `var(--chart-${(clusterIndex % 5) + 1})`,
                    points: series.points,
                })) ?? []
            );
        });

    const fetching = $derived(
        queries.some((query) => query.isFetching),
    );
    const pending = $derived(
        list.isPending || queries.some((query) => query.isPending),
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
            bind:paused
            disabled={!selection.length}
            {fetching}
            onrefresh={() =>
                queries.forEach((query) => void query.refetch())}
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
    {#if pending}
        <Skeleton loading loading-label="Loading HTTP traffic">
            <div class="grid gap-4 sm:grid-cols-2">
                {#each httpMetricNames as name (name)}<Frame>
                        <FrameHeader>
                            <FrameTitle>{name}</FrameTitle>
                        </FrameHeader><FramePanel>
                            <div class="h-48">Loading chart</div>
                        </FramePanel>
                    </Frame>{/each}
            </div>
        </Skeleton>
    {:else if !selection.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    Select a cluster
                </EmptyTitle><EmptyDescription>
                    Choose a cluster to inspect ingress traffic.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <div class="grid gap-4 sm:grid-cols-2">
            <Frame>
                <FrameHeader>
                    <FrameTitle>Requests per second</FrameTitle>
                </FrameHeader><FramePanel>
                    <MetricChart
                        series={chart("httpRequests")}
                        start={Math.min(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.start] : [],
                            ),
                            Infinity,
                        )}
                        end={Math.max(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.end] : [],
                            ),
                            0,
                        )}
                        unit="requests"
                    />
                </FramePanel>
            </Frame>
            <Frame>
                <FrameHeader>
                    <FrameTitle>5xx errors per second</FrameTitle>
                </FrameHeader><FramePanel>
                    <MetricChart
                        series={chart("httpErrors")}
                        start={Math.min(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.start] : [],
                            ),
                            Infinity,
                        )}
                        end={Math.max(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.end] : [],
                            ),
                            0,
                        )}
                        unit="requests"
                    />
                </FramePanel>
            </Frame>
            <Frame>
                <FrameHeader>
                    <FrameTitle>P95 latency</FrameTitle>
                </FrameHeader><FramePanel>
                    <MetricChart
                        series={chart("httpLatency")}
                        start={Math.min(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.start] : [],
                            ),
                            Infinity,
                        )}
                        end={Math.max(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.end] : [],
                            ),
                            0,
                        )}
                        unit="duration"
                    />
                </FramePanel>
            </Frame>
            <Frame>
                <FrameHeader>
                    <FrameTitle>P50 / P99 latency</FrameTitle>
                </FrameHeader><FramePanel>
                    <MetricChart
                        series={[
                            ...chart("httpLatencyP50"),
                            ...chart("httpLatencyP99").map(
                                (item) => ({ ...item, dashed: true }),
                            ),
                        ]}
                        start={Math.min(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.start] : [],
                            ),
                            Infinity,
                        )}
                        end={Math.max(
                            ...queries.flatMap((query) =>
                                query.data ? [query.data.end] : [],
                            ),
                            0,
                        )}
                        unit="duration"
                    />
                </FramePanel>
            </Frame>
        </div>
        <p class="text-xs text-muted-foreground">
            HTTP metrics are only available for services with
            configured HTTP/HTTPS ingress hostnames. Dashed latency
            lines are P99.
        </p>
    {/if}
</div>
