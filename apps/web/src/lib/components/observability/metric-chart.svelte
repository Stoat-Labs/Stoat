<script lang="ts">
    import { Chart } from "$lib/components/ui/chart";
    import {
        bandwidth,
        bridgeGaps,
        bytes,
        duration,
        percent,
        requests,
        type ChartSeries,
    } from "$lib/observability";
    import {
        AnnotationLine,
        ChartClipPath,
        Circle,
        LineChart,
        Spline,
        Tooltip,
        type ChartState,
        type HighlightPoint,
    } from "layerchart";

    let {
        series,
        start,
        end,
        unit = "percent",
        max,
        compact = false,
        markers = [],
        hoveredMachine = $bindable(""),
        onselecttime,
    }: {
        series: ChartSeries[];
        start: number;
        end: number;
        unit?: "percent" | "bytes" | "rate" | "requests" | "duration";
        max?: number;
        compact?: boolean;
        markers?: { key: string; time: number; label: string }[];
        hoveredMachine?: string;
        onselecttime?: (time: number) => void;
    } = $props();

    let context = $state<ChartState<Record<string, number | null>>>();

    const format = $derived(
        {
            percent,
            bytes,
            rate: bandwidth,
            requests,
            duration,
        }[unit],
    );

    const chartData = $derived.by(() => {
        // Rebuilt within this derivation; the temporary Map is not reactive state.
        const rows = new Map<
            number,
            { time: number; [key: string]: number | null }
        >();

        for (const item of series)
            for (const point of bridgeGaps(item.points)) {
                const row = rows.get(point.time) ?? {
                    time: point.time,
                };
                row[item.key] = point.value;
                rows.set(point.time, row);
            }

        return [...rows.values()].sort((a, b) => a.time - b.time);
    });

    // Hover opacity is applied on the Spline, not here: changing `series` makes LineChart rebuild its series state on every pointer move.
    const lines = $derived(
        series.map((item) => ({
            key: item.key,
            label: item.label,
            color: item.color,
            props: {
                "stroke-dasharray": item.dashed ? "4 3" : undefined,
            },
        })),
    );

    function opacity(key: string) {
        return !hoveredMachine ||
            series.find((item) => item.key === key)?.machineKey ===
                hoveredMachine
            ? 1
            : 0.15;
    }

    let pinned = $state("");

    function nearestLine(event: PointerEvent) {
        if (!context?.tooltip.data || !context.containerRef)
            return "";
        const y =
            event.clientY -
            context.containerRef.getBoundingClientRect().top -
            context.padding.top;
        let nearest = "";
        // Only counts as hovering a line when the pointer is within a few pixels of it.
        let distance = 8;

        for (const item of series) {
            const value = context.tooltip.data[item.key];

            if (value == null || !item.machineKey) continue;
            const delta = Math.abs(context.yScale(value) - y);

            if (delta < distance) {
                distance = delta;
                nearest = item.machineKey;
            }
        }

        return nearest;
    }

    function hover(event: PointerEvent) {
        if (compact) return;
        hoveredMachine = nearestLine(event) || pinned;
    }

    function select(event: PointerEvent) {
        if (compact) return;
        const line = nearestLine(event);
        pinned = line === pinned ? "" : line;
        hoveredMachine = pinned;
        const time = context?.tooltip.data?.time;

        if (time) onselecttime?.(time);
    }

    const config = $derived(
        Object.fromEntries(
            lines.map((item) => [
                item.key,
                { label: item.label, color: item.color },
            ]),
        ),
    );

    const hasData = $derived(
        series.some((item) =>
            item.points.some((point) => point.value !== null),
        ),
    );

    function time(value: number) {
        return new Date(value).toLocaleString(
            undefined,
            end - start > 86400
                ? { month: "short", day: "numeric", hour: "2-digit" }
                : { hour: "2-digit", minute: "2-digit" },
        );
    }
</script>

{#snippet hoverPoints({ points }: { points: HighlightPoint[] })}
    {#each points as point (point.seriesKey)}
        <Circle
            cx={point.x}
            cy={point.y}
            r={3}
            fill={point.fill}
            opacity={opacity(point.seriesKey ?? "")}
            class="pointer-events-none"
        />
    {/each}
{/snippet}

{#if hasData}
    <Chart
        {config}
        class={compact
            ? "h-8 w-24 shrink-0 aspect-auto"
            : "h-40 min-w-0 w-full aspect-auto sm:h-48 [&_.lc-highlight-line]:stroke-1! [&_.lc-highlight-line]:stroke-muted-foreground!"}
        aria-label={series.map((item) => item.label).join(", ")}
        onpointermove={hover}
        onpointerup={select}
        onpointerleave={() => (hoveredMachine = pinned)}
    >
        <!-- With no motion prop, domains derive synchronously as live data and ranges change. -->
        <LineChart
            bind:context
            data={chartData}
            x="time"
            series={lines}
            xDomain={[start * 1000, end * 1000]}
            xNice={false}
            yDomain={max ? [0, max] : undefined}
            seriesLayout="overlap"
            clip
            axis={!compact}
            grid={!compact}
            rule={false}
            highlight={compact
                ? false
                : {
                      axis: "x",
                      lines: { dashArray: "4 4" },
                      points: hoverPoints,
                  }}
            tooltipContext={!compact}
            padding={compact
                ? 2
                : { left: 58, bottom: 28, right: 12, top: 10 }}
            props={{
                xAxis: {
                    ticks: 3,
                    format: (value: number) => time(value),
                },
                yAxis: {
                    ticks: 3,
                    format: (value: number) => format(value),
                },
            }}
        >
            {#snippet marks()}
                <ChartClipPath>
                    {#each lines as line (line.key)}<Spline
                            seriesKey={line.key}
                            strokeWidth={compact ? 1.5 : 2}
                            opacity={opacity(line.key)}
                        />{/each}
                    {#each markers as marker (marker.key)}<AnnotationLine
                            x={marker.time}
                            label={marker.label}
                            labelPlacement="top-right"
                            class="pointer-events-none stroke-muted-foreground/60 text-[10px] [stroke-dasharray:2_3]"
                        />{/each}
                </ChartClipPath>
            {/snippet}
            {#snippet tooltip({ context })}
                {#if !compact}
                    <Tooltip.Root variant="none">
                        <div
                            class="space-y-2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                        >
                            <div class="font-medium">
                                {time(
                                    context.tooltip.data?.time ?? 0,
                                )}
                            </div>
                            {#each context.tooltip.series as item (item.key)}
                                <div
                                    class="flex items-center justify-between gap-4"
                                    style:opacity={opacity(
                                        item.key,
                                    ) === 1
                                        ? 1
                                        : 0.5}
                                >
                                    <span
                                        class="flex items-center gap-2"
                                    >
                                        <span
                                            class="size-2 shrink-0 rounded-full"
                                            style:background={item.color}
                                            aria-hidden="true"
                                        ></span>
                                        {item.label}
                                    </span>
                                    <span class="tabular-nums">
                                        {format(item.value)}
                                    </span>
                                </div>
                            {/each}
                        </div>
                    </Tooltip.Root>
                {/if}
            {/snippet}
        </LineChart>
    </Chart>
{:else}
    <div
        class={compact
            ? "w-24 text-center text-muted-foreground"
            : "flex h-40 items-center justify-center text-sm text-muted-foreground sm:h-48"}
    >
        {compact ? "—" : "No samples in this time range"}
    </div>
{/if}
