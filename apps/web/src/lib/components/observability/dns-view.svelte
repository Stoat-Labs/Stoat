<script lang="ts">
    import MetricChart from "./metric-chart.svelte";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        chartSeries,
        percent,
        requests,
        type MachineData,
    } from "$lib/observability";
    import {
        counterCount,
        counterPercent,
        counterTotal,
    } from "$lib/observability/counters";

    const {
        visibleMachines,
        start,
        end,
        loading,
    }: {
        visibleMachines: MachineData[];
        start: number;
        end: number;
        loading: boolean;
    } = $props();

    let hoveredMachine = $state("");

    const series = $derived(
        chartSeries(visibleMachines, "dnsQueries"),
    );

    const errorSeries = $derived(
        chartSeries(visibleMachines, "dnsErrors"),
    );

    const total = $derived(
        counterTotal(visibleMachines, "dnsQueries"),
    );

    const errors = $derived(
        counterTotal(visibleMachines, "dnsErrors"),
    );

    const average = $derived(
        total !== null && end > start ? total / (end - start) : null,
    );

    const cards = $derived([
        ["Total queries", counterCount(total)],
        ["Average rate", requests(average)],
        [
            "Failed queries",
            `${counterCount(errors)} · ${percent(counterPercent(errors, total))}`,
        ],
        [
            "Reporting machines",
            `${new Set(series.map((item) => item.machineKey)).size}`,
        ],
    ]);
</script>

<section class="min-w-0 space-y-3" aria-label="DNS metrics">
    <h2 class="text-sm font-semibold">DNS</h2>
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {#each cards as [label, value] (label)}
            <Frame class="min-w-0">
                <FrameHeader class="gap-1 py-3">
                    <FrameTitle class="text-xs text-muted-foreground">
                        {label}
                    </FrameTitle>
                    <p class="text-xl font-semibold tabular-nums">
                        {value}
                    </p>
                </FrameHeader>
            </Frame>
        {/each}
    </div>
    <p class="text-xs text-muted-foreground">
        Totals use the selected time range. Failed queries are Uncloud
        requests recorded with status “err”; scrape outages are shown
        under Collection health.
    </p>
    <Frame class="min-w-0 w-full">
        <FrameHeader>
            <FrameTitle>DNS queries</FrameTitle>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            {#if loading}
                <Skeleton loading loading-label="Loading DNS queries">
                    <div class="h-40 sm:h-48">Loading chart</div>
                </Skeleton>
            {:else}
                <MetricChart
                    {series}
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
                        series={errorSeries}
                        {start}
                        {end}
                        unit="requests"
                        bind:hoveredMachine
                    />
                </div>
                <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                    {#each series as item (item.key)}
                        <span
                            class="flex items-center gap-2 text-xs"
                            style:opacity={hoveredMachine &&
                            hoveredMachine !== item.machineKey
                                ? 0.4
                                : 1}
                        >
                            <span
                                class="size-2 rounded-full"
                                style:background={item.color}
                            ></span>
                            {item.label}
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
