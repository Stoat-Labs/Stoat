<script lang="ts">
    import {
        Meter,
        MeterIndicator,
        MeterTrack,
    } from "$lib/components/ui/meter";
    import { count, percent } from "$lib/observability";

    let {
        label,
        rows,
    }: {
        /** Accessible name of the list. */
        label: string;
        rows: { key: string; label: string; requests: number }[];
    } = $props();

    const total = $derived(
        rows.reduce((sum, row) => sum + row.requests, 0),
    );
</script>

<ul class="space-y-3" aria-label={label}>
    {#each rows as row (row.key)}
        {@const share = total ? (100 * row.requests) / total : 0}
        <li class="space-y-1.5">
            <div
                class="flex items-baseline justify-between gap-3 text-sm"
            >
                <span class="truncate">{row.label}</span>
                <span class="shrink-0 tabular-nums">
                    {count(row.requests)}
                    <span class="ml-1 text-xs text-muted-foreground">
                        {percent(share)}
                    </span>
                </span>
            </div>
            <Meter value={share} aria-label={row.label}>
                <MeterTrack class="h-1.5 rounded-full">
                    <MeterIndicator class="rounded-full" />
                </MeterTrack>
            </Meter>
        </li>
    {/each}
</ul>
