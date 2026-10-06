<script lang="ts">
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { cn } from "$lib/utils";
    import type { Snippet } from "svelte";

    let {
        title,
        description,
        count,
        panelClass,
        actions,
        children,
    }: {
        title: string;
        description: string;
        count?: string;
        panelClass?: string;
        actions?: Snippet;
        children: Snippet;
    } = $props();

    const headingId = $props.id();
</script>

<Frame
    class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:grid-rows-subgrid"
    role="region"
    aria-labelledby={headingId}
>
    <FrameHeader
        class="flex-row flex-wrap items-start justify-between gap-2"
    >
        <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
                <FrameTitle class="text-base">
                    <h2 id={headingId}>{title}</h2>
                </FrameTitle>
                {#if count}
                    <span
                        class="text-xs tabular-nums text-muted-foreground"
                    >
                        {count}
                    </span>
                {/if}
            </div>
            <FrameDescription class="mt-1">
                {description}
            </FrameDescription>
        </div>
        {#if actions}
            <div class="flex flex-wrap items-center gap-2">
                {@render actions()}
            </div>
        {/if}
    </FrameHeader>
    <FramePanel class={cn("min-w-0", panelClass)}>
        {@render children()}
    </FramePanel>
</Frame>
