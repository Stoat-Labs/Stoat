<script lang="ts" module>
    export const edgeLayers = ["references", "dependencies"] as const;

    export type EdgeLayer = (typeof edgeLayers)[number];
</script>

<script lang="ts">
    import {
        Menu,
        MenuCheckboxItem,
        MenuGroup,
        MenuGroupLabel,
        MenuItem,
        MenuPopup,
        MenuSeparator,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        Tooltip,
        TooltipPopup,
        TooltipTrigger,
    } from "$lib/components/ui/tooltip";
    import Grip from "@lucide/svelte/icons/grip";
    import Layers from "@lucide/svelte/icons/layers";
    import Maximize2 from "@lucide/svelte/icons/maximize-2";
    import Minus from "@lucide/svelte/icons/minus";
    import Plus from "@lucide/svelte/icons/plus";
    import Redo2 from "@lucide/svelte/icons/redo-2";
    import Undo2 from "@lucide/svelte/icons/undo-2";
    import { useSvelteFlow } from "@xyflow/svelte";
    import type { Component } from "svelte";
    import { tick } from "svelte";

    let {
        hidden,
        canUndo,
        canRedo,
        onlayers,
        onautolayout,
        onrepair,
        onundo,
        onredo,
    }: {
        /** Connection layers currently hidden. */
        hidden: EdgeLayer[];
        canUndo: boolean;
        canRedo: boolean;
        onlayers: (hidden: EdgeLayer[]) => void;
        onautolayout: () => void;
        onrepair: () => void;
        onundo: () => void;
        onredo: () => void;
    } = $props();

    // Only usable inside <SvelteFlow>, which is why this lives in its own component.
    const flow = useSvelteFlow();

    const fit = { maxZoom: 1, padding: 0.2, duration: 200 };

    async function andFit(run: () => void) {
        run();
        await tick();
        void flow.fitView(fit);
    }

    const allHidden = $derived(hidden.length === edgeLayers.length);

    function toggle(layer: EdgeLayer, visible: boolean) {
        onlayers(
            visible
                ? hidden.filter((name) => name !== layer)
                : [...hidden, layer],
        );
    }

    // Railway's middle groups: zoom and history.
    const groups: {
        label: string;
        icon: Component;
        disabled: boolean;
        run: () => void;
    }[][] = $derived([
        [
            {
                label: "Zoom in",
                icon: Plus,
                disabled: false,
                run: () => void flow.zoomIn({ duration: 150 }),
            },
            {
                label: "Zoom out",
                icon: Minus,
                disabled: false,
                run: () => void flow.zoomOut({ duration: 150 }),
            },
            {
                label: "Center canvas",
                icon: Maximize2,
                disabled: false,
                run: () => void flow.fitView(fit),
            },
        ],
        [
            {
                label: "Undo",
                icon: Undo2,
                disabled: !canUndo,
                run: onundo,
            },
            {
                label: "Redo",
                icon: Redo2,
                disabled: !canRedo,
                run: onredo,
            },
        ],
    ]);

    const box =
        "flex size-[34px] items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
</script>

{#snippet single(label: string, icon: Component)}
    {@const Icon = icon}
    <MenuTrigger
        class="flex size-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-popup-open:text-foreground"
        aria-label={label}
    >
        <Icon class="size-4" aria-hidden="true" />
    </MenuTrigger>
{/snippet}

<!-- Railway's bottom-left stack: settings, zoom, history, layers; 36px bordered boxes 8px apart. -->
<div class="flex flex-col gap-2">
    <Menu>
        {@render single("Canvas settings", Grip)}
        <MenuPopup side="right" align="start" class="min-w-52">
            <MenuItem
                onclick={() =>
                    onlayers(allHidden ? [] : [...edgeLayers])}
            >
                {allHidden ? "Show connections" : "Hide connections"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onclick={() => void andFit(onautolayout)}>
                Auto layout
            </MenuItem>
            <MenuItem onclick={onrepair}>Repair overlaps</MenuItem>
        </MenuPopup>
    </Menu>

    {#each groups as group, index (index)}
        <div
            class="flex w-9 flex-col overflow-hidden rounded-md border border-border bg-card"
        >
            {#each group as action (action.label)}
                <Tooltip>
                    <TooltipTrigger
                        class={box}
                        aria-label={action.label}
                        disabled={action.disabled}
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

    <Menu>
        {@render single("Visibility layers", Layers)}
        <MenuPopup side="right" align="end" class="min-w-60">
            <MenuGroup>
                <MenuGroupLabel>Connections</MenuGroupLabel>
                <MenuCheckboxItem
                    checked={!hidden.includes("references")}
                    onCheckedChange={(checked) =>
                        toggle("references", checked)}
                >
                    Variable references
                </MenuCheckboxItem>
                <MenuCheckboxItem
                    checked={!hidden.includes("dependencies")}
                    onCheckedChange={(checked) =>
                        toggle("dependencies", checked)}
                >
                    Service dependencies
                </MenuCheckboxItem>
            </MenuGroup>
        </MenuPopup>
    </Menu>
</div>
