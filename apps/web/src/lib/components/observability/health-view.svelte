<script lang="ts">
    import ScrapeTimeline from "./scrape-timeline.svelte";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        chartSeries,
        type MachineData,
    } from "$lib/observability";

    const {
        visibleMachines,
        start,
        end,
        step,
        loading,
    }: {
        visibleMachines: MachineData[];
        start: number;
        end: number;
        step: number;
        loading: boolean;
    } = $props();
</script>

<section class="min-w-0 space-y-3" aria-label="Collection health">
    <h2 class="text-sm font-semibold">Collection health</h2>
    <Frame class="min-w-0 w-full">
        <FrameHeader>
            <FrameTitle>Uncloud scrape health</FrameTitle>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            {#if loading}
                <Skeleton
                    loading
                    loading-label="Loading Uncloud scrape health"
                >
                    <div class="h-40 sm:h-48">Loading timeline</div>
                </Skeleton>
            {:else}
                <ScrapeTimeline
                    series={chartSeries(
                        visibleMachines,
                        "dnsAvailability",
                    )}
                    {start}
                    {end}
                    {step}
                />
            {/if}
            <p class="mt-2 text-xs text-muted-foreground">
                Each interval shows any recorded scrape failure.
                Missing data is unknown, not healthy. This is not DNS
                resolution health.
            </p>
        </FramePanel>
    </Frame>
</section>
