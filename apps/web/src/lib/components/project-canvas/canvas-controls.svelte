<script lang="ts">
    import {
        Tooltip,
        TooltipPopup,
        TooltipTrigger,
    } from "$lib/components/ui/tooltip";
    import LayoutGrid from "@lucide/svelte/icons/layout-grid";
    import Maximize from "@lucide/svelte/icons/maximize";
    import Minus from "@lucide/svelte/icons/minus";
    import Plus from "@lucide/svelte/icons/plus";
    import { useSvelteFlow } from "@xyflow/svelte";
    import type { Component } from "svelte";
    import { tick } from "svelte";

    let { onreset }: { onreset: () => void } = $props();

    // Only usable inside <SvelteFlow>, which is why this lives in its own component.
    const flow = useSvelteFlow();

    const fit = { maxZoom: 1, padding: 0.2, duration: 200 };

    async function resetLayout() {
        onreset();
        await tick();
        void flow.fitView(fit);
    }

    // Railway stacks its canvas controls in small bordered groups.
    const groups: {
        label: string;
        icon: Component;
        run: () => void;
    }[][] = [
        [
            {
                label: "Zoom in",
                icon: Plus,
                run: () => void flow.zoomIn({ duration: 150 }),
            },
            {
                label: "Zoom out",
                icon: Minus,
                run: () => void flow.zoomOut({ duration: 150 }),
            },
            {
                label: "Fit to screen",
                icon: Maximize,
                run: () => void flow.fitView(fit),
            },
        ],
        [
            {
                label: "Reset layout",
                icon: LayoutGrid,
                run: resetLayout,
            },
        ],
    ];
</script>

<div class="flex flex-col gap-2">
    {#each groups as group, index (index)}
        <div
            class="flex w-9 flex-col overflow-hidden rounded-md border border-border bg-card"
        >
            {#each group as action (action.label)}
                <Tooltip>
                    <TooltipTrigger
                        class="flex size-[34px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        aria-label={action.label}
                        onclick={action.run}
                    >
                        <action.icon
                            class="size-4"
                            aria-hidden="true"
                        />
                    </TooltipTrigger>
                    <TooltipPopup side="right">
                        {action.label}
                    </TooltipPopup>
                </Tooltip>
            {/each}
        </div>
    {/each}
</div>
