<script lang="ts">
    import { Button } from "$lib/components/ui/button";

    let {
        live,
        timezone,
        searchSummary,
        hasMore,
        capped,
        pending,
        onloadolder,
    }: {
        live: boolean;
        timezone: string;
        searchSummary: string;
        /** A cursor for older results exists. */
        hasMore: boolean;
        /** The history buffer is full, so older pages cannot be loaded. */
        capped: boolean;
        pending: boolean;
        onloadolder: () => void;
    } = $props();
</script>

<div
    class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
>
    {#if live}
        <span>{timezone}</span>
    {:else}
        <p class="min-w-0 flex-1 truncate" title={searchSummary}>
            {searchSummary}
        </p>
        {#if hasMore}<Button
                variant="outline"
                size="sm"
                loading={pending}
                disabled={pending || capped}
                onclick={onloadolder}
            >
                Load older
            </Button>{/if}
        {#if capped && hasMore}<span>
                Narrow the range to browse more than 2,000 lines.
            </span>{/if}
    {/if}
</div>
