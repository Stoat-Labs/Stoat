<script lang="ts">
    import "skullet/styles.css";
    import { Skeleton } from "skullet/svelte";
    import type { Snippet } from "svelte";
    import { cn } from "$lib/utils";

    let {
        loading = false,
        label,
        count = 1,
        gap = 0,
        fill = false,
        class: className,
        style,
        children,
    }: {
        loading?: boolean;
        label?: string;
        /** Times the children are repeated while loading. */
        count?: number;
        /** Pixels between repeated children. */
        gap?: number;
        /** Fills a flex column, so a `flex-1` child keeps filling the space. */
        fill?: boolean;
        class?: string;
        style?: string;
        children: Snippet;
    } = $props();
</script>

<Skeleton
    {loading}
    {label}
    {style}
    class={cn(
        fill && "skeleton-fill flex min-h-0 flex-1 flex-col",
        className,
    )}
>
    {#if loading && count > 1}
        <div class="flex flex-col" style:gap="{gap}px">
            {#each { length: count }, index (index)}
                {@render children()}
            {/each}
        </div>
    {:else}
        {@render children()}
    {/if}
</Skeleton>

<style>
    /* Skullet nests the content a few divs deep; each passes the fill down. */
    :global(
        .skeleton-fill > [skullet-pane],
        .skeleton-fill > [skullet-pane] > div,
        .skeleton-fill
            [skullet-loading]
            > :is([skullet-ghost], [skullet-snapshot])
    ) {
        display: flex;
        flex: 1;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
    }
</style>
