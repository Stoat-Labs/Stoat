<script lang="ts">
    import {
        Tooltip,
        TooltipPopup,
        TooltipProvider,
        TooltipTrigger,
    } from "$lib/components/ui/tooltip";
    import type { ChartSeries } from "$lib/observability";

    let {
        series,
        start,
        end,
        step,
    }: {
        series: ChartSeries[];
        start: number;
        end: number;
        step: number;
    } = $props();

    const states = {
        ok: {
            label: "Scrape succeeded",
            color: "bg-success-foreground",
        },
        failed: {
            label: "Scrape failed",
            color: "bg-destructive-foreground",
        },
        missing: {
            label: "No data",
            color: "bg-muted-foreground/25",
        },
    };

    const rows = $derived(
        series.map((item) => {
            const values = new Map(
                item.points.map((point) => [point.time, point.value]),
            );

            const intervals = Array.from(
                { length: Math.floor((end - start) / step) },
                (_, index) => {
                    const time = (start + (index + 1) * step) * 1000;
                    const value = values.get(time);

                    let state: keyof typeof states = "missing";

                    if (value === 1) state = "ok";
                    else if (value === 0) state = "failed";

                    return { time, state };
                },
            );

            return { ...item, intervals };
        }),
    );

    function time(value: number) {
        return new Date(value).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }
</script>

<TooltipProvider delay={100}>
    <div class="flex min-h-48 min-w-0 flex-col justify-center gap-4">
        {#each rows as row (row.key)}
            <div class="min-w-0 space-y-1.5">
                <div
                    class="flex items-center justify-between gap-2 text-xs"
                >
                    <span class="truncate font-medium">
                        {row.label}
                    </span>
                    <span class="shrink-0 text-muted-foreground">
                        {states[
                            row.intervals.at(-1)?.state ?? "missing"
                        ].label}
                    </span>
                </div>
                <div
                    class="flex h-6 min-w-0 gap-px overflow-hidden rounded-sm"
                    role="img"
                    aria-label={`${row.label}: ${row.intervals.filter((interval) => interval.state === "ok").length} successful, ${row.intervals.filter((interval) => interval.state === "failed").length} failed, ${row.intervals.filter((interval) => interval.state === "missing").length} missing intervals`}
                >
                    {#each row.intervals as interval (interval.time)}
                        <Tooltip>
                            <TooltipTrigger
                                type="button"
                                aria-label={`${time(interval.time - step * 1000)} – ${time(interval.time)}: ${states[interval.state].label}`}
                                class="min-w-0 flex-1 cursor-help border-0 p-0 outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <span
                                    class={`block h-6 min-w-0 ${states[interval.state].color}`}
                                ></span>
                            </TooltipTrigger>
                            <TooltipPopup side="top" sideOffset={8}>
                                {time(interval.time - step * 1000)} – {time(
                                    interval.time,
                                )}: {states[interval.state].label}
                            </TooltipPopup>
                        </Tooltip>
                    {/each}
                </div>
            </div>
        {:else}
            <p class="text-center text-sm text-muted-foreground">
                No scrape targets in this time range
            </p>
        {/each}
        <div
            class="flex justify-between gap-2 text-[10px] text-muted-foreground"
        >
            <span>{time(start * 1000)}</span>
            <span>{time(end * 1000)}</span>
        </div>
        <div
            class="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
        >
            {#each Object.entries(states) as [key, state] (key)}
                <span class="flex items-center gap-1.5">
                    <span
                        class={`size-2 rounded-sm ${state.color}`}
                        aria-hidden="true"
                    ></span>
                    {state.label}
                </span>
            {/each}
        </div>
    </div>
</TooltipProvider>
