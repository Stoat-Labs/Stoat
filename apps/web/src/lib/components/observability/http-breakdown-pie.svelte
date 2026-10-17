<script lang="ts">
    import {
        breakdownColors,
        count,
        percent,
    } from "$lib/observability";
    import { defineChart } from "@tanstack/charts";
    import { pie, polar, radialArc } from "@tanstack/charts/polar";
    import { Chart } from "@tanstack/charts/svelte";

    // One legend row is a text-sm line (20px) plus the space-y-2.5 gap.
    const rowHeight = 20;
    const rowGap = 10;

    let {
        label,
        rows: allRows,
    }: {
        /** Accessible name of the chart and its legend. */
        label: string;
        /** Sorted by requests, descending. Rows that don't fit the available height fold into one. */
        rows: { key: string; label: string; requests: number }[];
    } = $props();

    let legendHeight = $state(0);

    const rows = $derived.by(() => {
        const fits = Math.max(
            1,
            Math.floor(
                (legendHeight + rowGap) / (rowHeight + rowGap),
            ),
        );

        if (allRows.length <= fits) return allRows;

        const rest = allRows.slice(fits - 1);

        return [
            ...allRows.slice(0, fits - 1),
            {
                // Never a real label value, unlike "other", which Alloy uses for clients.
                key: "more",
                label: `${rest.length} more`,
                requests: rest.reduce(
                    (sum, row) => sum + row.requests,
                    0,
                ),
            },
        ];
    });

    const total = $derived(
        rows.reduce((sum, row) => sum + row.requests, 0),
    );

    const colors = $derived(
        breakdownColors(rows.map((row) => row.key)),
    );

    const definition = $derived(
        defineChart({
            marks: [
                polar({
                    inset: 2,
                    radiusRatio: 1,
                    marks: [
                        radialArc(
                            pie(rows, {
                                value: "requests",
                                gapAngle: 0.03,
                            }),
                            {
                                cornerRadius: 3,
                                color: "key",
                                key: "key",
                            },
                        ),
                    ],
                    scales: { angle: null, radius: null },
                }),
            ],
            scales: { x: null, y: null },
            color: {
                domain: [...colors.keys()],
                range: [...colors.values()],
            },
            keyboard: false,
        }),
    );
</script>

<div class="flex h-full flex-col items-center gap-6 sm:flex-row">
    <Chart
        {definition}
        ariaLabel={label}
        width={144}
        height={144}
        tabIndex={-1}
        class="shrink-0"
    />
    <div
        class="relative min-h-36 w-full min-w-0 flex-1 self-stretch"
        bind:clientHeight={legendHeight}
    >
        <ul
            class="absolute inset-0 space-y-2.5 overflow-hidden"
            aria-label={label}
        >
            {#each rows as row (row.key)}
                <li class="flex items-center gap-2 text-sm">
                    <span
                        class="size-2.5 shrink-0 rounded-sm"
                        style:background={colors.get(row.key)}
                        aria-hidden="true"
                    ></span>
                    <span class="min-w-0 flex-1 truncate">
                        {row.label}
                    </span>
                    <span class="shrink-0 tabular-nums">
                        {count(row.requests)}
                    </span>
                    <span
                        class="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                    >
                        {percent(
                            total ? (100 * row.requests) / total : 0,
                        )}
                    </span>
                </li>
            {/each}
        </ul>
    </div>
</div>
