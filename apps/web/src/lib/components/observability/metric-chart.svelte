<script lang="ts">
    import {
        bandwidth,
        bridgeGaps,
        bytes,
        count,
        duration,
        percent,
        perSecond,
        requests,
        type ChartSeries,
        type MetricUnit,
    } from "$lib/observability";
    import CanvasChart from "./canvas-chart.svelte";
    import { metricChartCursor } from "./chart-sync";
    import {
        crosshair,
        defineChart,
        lineY,
        ruleX,
        ruleY,
        text,
        type ChartInteractionController,
        type ChartPoint,
    } from "@tanstack/charts";
    import { cursorHost } from "@tanstack/charts/cursor";
    import { decorative } from "@tanstack/charts/mark/decorative";
    import { scaleLinear } from "@tanstack/charts/scales/linear";
    import { tooltip } from "@tanstack/charts/tooltip";
    import { portal } from "@tanstack/charts/tooltip/portal";

    let {
        series,
        start,
        end,
        unit = "percent",
        max,
        compact = false,
        tooltipRows = 16,
        markers = [],
        hoveredMachine = $bindable(""),
        onselecttime,
    }: {
        series: ChartSeries[];
        start: number;
        end: number;
        unit?: MetricUnit;
        max?: number;
        compact?: boolean;
        tooltipRows?: number;
        markers?: { key: string; time: number; label: string }[];
        hoveredMachine?: string;
        onselecttime?: (time: number) => void;
    } = $props();

    type Row = { time: number; value: number | null };

    const cursor = metricChartCursor();

    // Synced charts share the crosshair, but only the chart under the pointer shows a tooltip.
    let pointerInside = $state(false);

    const format = $derived(
        {
            percent,
            bytes,
            rate: bandwidth,
            requests,
            duration,
            count,
            perSecond,
        }[unit],
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

    function dimmed(item: ChartSeries) {
        return !!hoveredMachine && item.machineKey !== hoveredMachine;
    }

    type TooltipRow = {
        label: string;
        value: string;
        color: string;
        active: boolean;
    };

    // Dozens of rows overflow the screen, so keep the hovered line plus the highest ones.
    function capRows(rows: TooltipRow[]) {
        if (rows.length <= tooltipRows) return rows;

        const kept = rows.slice(0, tooltipRows);
        const active = rows.find((row) => row.active);

        if (active && !kept.includes(active))
            kept[kept.length - 1] = active;

        return [
            ...kept,
            {
                label: `+${rows.length - kept.length} more`,
                value: "",
                color: "transparent",
                active: false,
            },
        ];
    }

    // Each series is its own mark so it keeps its own color, dash and hover opacity.
    const lines = $derived(
        series.map((item) =>
            lineY<Row>(bridgeGaps(item.points), {
                id: item.key,
                x: "time",
                y: "value",
                // Grouped focus dedupes by series, so every line needs its own group.
                z: () => item.key,
                stroke: item.color,
                strokeWidth: compact ? 1.5 : 2,
                strokeOpacity: dimmed(item) ? 0.15 : 1,
                strokeDasharray: item.dashed ? "4 3" : undefined,
            }),
        ),
    );

    const seriesByKey = $derived(
        new Map(series.map((item) => [item.key, item])),
    );

    const definition = $derived(
        defineChart({
            marks: [
                // Keeps zero in the inferred y domain, like a baseline.
                ruleY([0], { strokeOpacity: compact ? 0 : 0.15 }),
                ...lines,
                ruleX(markers, {
                    x: "time",
                    strokeOpacity: 0.6,
                    strokeDasharray: "2 3",
                }),
                decorative(
                    text(markers, {
                        x: "time",
                        y: () => 1,
                        yScale: "marker",
                        text: "label",
                        anchor: "start",
                        dx: 4,
                        dy: 6,
                        fontSize: 10,
                    }),
                ),
                crosshair({
                    x: { strokeDasharray: "4 4" },
                    y: false,
                }),
            ],
            scales: {
                x: {
                    scale: scaleLinear().domain([
                        start * 1000,
                        end * 1000,
                    ]),
                    axis: {
                        line: false,
                        ticks: { count: 3, size: 0, format: time },
                    },
                },
                y: {
                    scale: max
                        ? scaleLinear().domain([0, max])
                        : scaleLinear,
                    nice: !max,
                    grid: true,
                    axis: {
                        line: false,
                        ticks: { count: 3, size: 0, format },
                    },
                },
                // Fixed 0..1 scale that pins marker labels to the top of the plot.
                marker: {
                    channel: "y",
                    scale: scaleLinear().domain([0, 1]),
                    axis: false,
                },
            },
            guides: !compact,
            clip: true,
            margin: compact ? 2 : undefined,
            pointer: !compact,
            keyboard: !compact,
            focus: "group-x",
            maxFocusDistance: Number.POSITIVE_INFINITY,
            focusRing: { radius: 3, strokeWidth: 1.5 },
            cursor:
                cursor && !compact
                    ? {
                          use: cursorHost,
                          controller: cursor,
                          mode: "focus",
                          match: "x",
                      }
                    : undefined,
            tooltip:
                compact || (cursor && !pointerInside)
                    ? false
                    : {
                          use: tooltip,
                          portal,
                          sticky: false,
                          anchor: "pointer",
                          placement: [
                              "right",
                              "left",
                              "bottom",
                              "top",
                          ],
                          offset: 12,
                          content: (points) => ({
                              title: time(
                                  Number(points[0]?.xValue ?? 0),
                              ),
                              rows: capRows(
                                  points
                                      .toSorted(
                                          (a, b) =>
                                              Number(b.yValue) -
                                              Number(a.yValue),
                                      )
                                      .flatMap((point) => {
                                          const item =
                                              seriesByKey.get(
                                                  point.markId,
                                              );

                                          return item
                                              ? [
                                                    {
                                                        label: item.label,
                                                        value: format(
                                                            Number(
                                                                point.yValue,
                                                            ),
                                                        ),
                                                        color: item.color,
                                                        active:
                                                            !!hoveredMachine &&
                                                            item.machineKey ===
                                                                hoveredMachine,
                                                    },
                                                ]
                                              : [];
                                      }),
                              ),
                          }),
                      },
        }),
    );

    let interaction:
        | ChartInteractionController<Row, number, number>
        | undefined;

    let focused: readonly ChartPoint<Row, number, number>[] = [];

    let pinned = $state("");

    function nearestLine(event: PointerEvent) {
        const position = interaction?.clientToScene(
            event.clientX,
            event.clientY,
        );

        if (!position) return "";
        let nearest = "";
        // Only counts as hovering a line when the pointer is within a few pixels of it.
        let distance = 8;

        for (const point of focused) {
            const machine = seriesByKey.get(point.markId)?.machineKey;
            const delta = Math.abs(point.y - position.y);

            if (machine && delta < distance) {
                distance = delta;
                nearest = machine;
            }
        }

        return nearest;
    }

    function hover(event: PointerEvent) {
        hoveredMachine = nearestLine(event) || pinned;
    }

    function select(event: PointerEvent) {
        const line = nearestLine(event);
        pinned = line === pinned ? "" : line;
        hoveredMachine = pinned;
        const time = focused[0]?.xValue;

        if (time) onselecttime?.(Number(time));
    }
</script>

{#if hasData}
    {#if compact}
        <div class="h-8 w-24 shrink-0">
            <CanvasChart
                {definition}
                ariaLabel={series
                    .map((item) => item.label)
                    .join(", ")}
                class="size-full"
            />
        </div>
    {:else}
        <div
            role="presentation"
            class="h-40 min-w-0 w-full text-xs text-muted-foreground sm:h-48 [--ts-chart-tooltip-background:var(--popover)] [--ts-chart-tooltip-border-radius:var(--radius)] [--ts-chart-tooltip-border:1px_solid_var(--border)] [--ts-chart-tooltip-color:var(--popover-foreground)]"
            onpointerenter={() => (pointerInside = true)}
            onpointermove={hover}
            onpointerup={select}
            onpointerleave={() => {
                pointerInside = false;
                hoveredMachine = pinned;
            }}
        >
            <CanvasChart
                {definition}
                ariaLabel={series
                    .map((item) => item.label)
                    .join(", ")}
                class="size-full"
                onRender={(context) =>
                    (interaction = context.interaction)}
                onFocusGroupChange={(points) => (focused = points)}
            />
        </div>
    {/if}
{:else}
    <div
        class={compact
            ? "w-24 text-center text-muted-foreground"
            : "flex h-40 items-center justify-center text-sm text-muted-foreground sm:h-48"}
    >
        {compact ? "—" : "No samples in this time range"}
    </div>
{/if}
