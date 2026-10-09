<script module lang="ts">
    import type {
        ChartSeries,
        MetricUnit,
        ServiceRow,
    } from "$lib/observability";

    export type ServiceChart = {
        title: string;
        unit: MetricUnit;
        series: ChartSeries[];
    };
</script>

<script lang="ts">
    import MetricChart from "./metric-chart.svelte";
    import ServicesTable from "./services-table.svelte";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";

    let {
        services,
        charts,
        loading,
        start,
        end,
        search = $bindable(""),
    }: {
        services: ServiceRow[];
        charts: ServiceChart[];
        loading: boolean;
        start: number;
        end: number;
        search?: string;
    } = $props();

    let hoveredService = $state("");
</script>

<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    {#each charts as chart (chart.title)}
        <Frame class="min-w-0">
            <FrameHeader>
                <FrameTitle>{chart.title}</FrameTitle>
            </FrameHeader>
            <FramePanel class="flex min-w-0 flex-1 flex-col p-4">
                {#if loading}
                    <Skeleton
                        loading
                        loading-label="Loading service metrics"
                    >
                        <div class="h-40 sm:h-48">Loading chart</div>
                    </Skeleton>
                {:else}
                    <MetricChart
                        series={chart.series}
                        {start}
                        {end}
                        unit={chart.unit}
                        bind:hoveredMachine={hoveredService}
                    />
                {/if}
            </FramePanel>
        </Frame>
    {/each}
</div>

<ServicesTable
    data={services}
    {start}
    {end}
    bind:search
    bind:hovered={hoveredService}
/>
