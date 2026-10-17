<script lang="ts">
    import {
        breakdownColors,
        count,
        percent,
    } from "$lib/observability";

    let {
        label,
        rows,
    }: {
        /** Accessible name of the bar and its legend. */
        label: string;
        rows: { key: string; label: string; requests: number }[];
    } = $props();

    const total = $derived(
        rows.reduce((sum, row) => sum + row.requests, 0),
    );

    const colors = $derived(
        breakdownColors(rows.map((row) => row.key)),
    );

    function share(requests: number) {
        return total ? (100 * requests) / total : 0;
    }
</script>

<!-- One bar split into every row's share, so the parts always add up to the whole. -->
<div class="space-y-3">
    <div
        class="flex h-2.5 w-full gap-0.5"
        role="img"
        aria-label={`${label}: ${rows
            .map(
                (row) =>
                    `${row.label} ${percent(share(row.requests))}`,
            )
            .join(", ")}`}
    >
        {#each rows as row (row.key)}
            <!-- Tiny shares keep a sliver so every legend entry has a visible segment. -->
            <span
                class="h-full min-w-1 rounded-sm"
                style:flex-grow={row.requests}
                style:flex-basis="0"
                style:background={colors.get(row.key)}
            ></span>
        {/each}
    </div>
    <ul class="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={label}>
        {#each rows as row (row.key)}
            <li class="flex items-center gap-2 text-sm">
                <span
                    class="size-2.5 shrink-0 rounded-sm"
                    style:background={colors.get(row.key)}
                    aria-hidden="true"
                ></span>
                {row.label}
                <span class="tabular-nums text-muted-foreground">
                    {count(row.requests)} · {percent(
                        share(row.requests),
                    )}
                </span>
            </li>
        {/each}
    </ul>
</div>
