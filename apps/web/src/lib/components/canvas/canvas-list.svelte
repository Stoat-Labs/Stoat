<script lang="ts">
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import FileCog from "$lib/components/shared/file-gear-icon.svelte";
    import HardDrive from "$lib/components/shared/hard-drive-icon.svelte";
    import Box from "phosphor-svelte/lib/CubeIcon";
    import ChartLine from "phosphor-svelte/lib/ChartLineIcon";
    import Folder from "phosphor-svelte/lib/FolderIcon";
    import { getCanvasActions } from "./context";
    import {
        cardTrays,
        type CanvasNode,
        type CardData,
    } from "./graph";
    import ResourceStatus from "./nodes/resource-status.svelte";

    let {
        nodes,
        onselect,
    }: {
        nodes: CanvasNode[];
        onselect: (nodeId: string) => void;
    } = $props();

    const actions = getCanvasActions();

    type CardNode = Extract<CanvasNode, { type: "card" }>;

    // The canvas's cards in their build order, ungrouped ones first, then one section per group.
    const sections = $derived.by(() => {
        const cards = nodes.filter(
            (node): node is CardNode => node.type === "card",
        );

        const groups = nodes.flatMap((node) =>
            node.type === "stack" && node.data.group ? [node] : [],
        );

        return [
            {
                id: "",
                name: undefined,
                cards: cards.filter((card) => !card.data.groupId),
            },
            ...groups.map((group) => ({
                id: group.id,
                name: group.data.name,
                cards: cards.filter(
                    (card) => card.data.groupId === group.id,
                ),
            })),
        ].filter((section) => section.cards.length > 0);
    });

    function title(data: CardData) {
        if (data.volume) return data.volume.name;

        if (data.config) return data.config.name;

        return data.shared && data.service
            ? data.service.name
            : data.resource.name;
    }
</script>

{#snippet icon(data: CardData)}
    {#if data.volume}
        <HardDrive
            class="size-6 shrink-0"
            weight="regular"
            aria-hidden="true"
        />
    {:else if data.config}
        <FileCog
            class="size-6 shrink-0"
            weight="regular"
            aria-hidden="true"
        />
    {:else if data.icon}
        <img
            src={data.icon}
            alt=""
            aria-hidden="true"
            class="size-6 shrink-0 object-contain"
        />
    {:else if data.resource.type === "bucket"}
        <BucketIcon class="size-6 shrink-0" aria-hidden="true" />
    {:else}
        <Box
            class="size-6 shrink-0"
            weight="regular"
            aria-hidden="true"
        />
    {/if}
{/snippet}

<!-- Narrow screens get a plain list of the canvas's cards instead of the pannable graph. -->
<div class="size-full space-y-6 overflow-y-auto p-4">
    {#each sections as section (section.id)}
        <section class="space-y-2">
            {#if section.name}
                <h3
                    class="px-1 text-sm font-medium text-muted-foreground"
                >
                    {section.name}
                </h3>
            {/if}
            {#each section.cards as card (card.id)}
                {@const data = card.data}
                {@const domain = data.service?.domains[0]}
                <div
                    class={[
                        "overflow-hidden rounded-lg border bg-card transition-colors",
                        card.selected
                            ? "border-primary"
                            : "border-foreground/14",
                    ]}
                >
                    <button
                        type="button"
                        class="flex w-full items-center gap-3 p-4 text-left"
                        onclick={() => onselect(card.id)}
                    >
                        {@render icon(data)}
                        <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate font-semibold">
                                {title(data)}
                            </span>
                            {#if domain}
                                <span
                                    class="truncate text-sm text-muted-foreground"
                                >
                                    {domain}
                                </span>
                            {/if}
                        </span>
                        <span class="shrink-0 text-sm">
                            {#if data.volume || data.config}
                                <span class="text-muted-foreground">
                                    Not mounted
                                </span>
                            {:else if actions.isPendingDelete(data.resource.id)}
                                <span
                                    class="text-destructive-foreground"
                                >
                                    Will be deleted
                                </span>
                            {:else if data.parseError}
                                <span
                                    class="text-destructive-foreground"
                                >
                                    Can't read spec
                                </span>
                            {:else}
                                <ResourceStatus
                                    resource={data.resource}
                                    draftOnly={data.draftOnly}
                                />
                            {/if}
                        </span>
                    </button>
                    <!-- The card's volume, config and metrics trays, as on the canvas. -->
                    {#each cardTrays(data.service) as { kind, name } (`${kind}:${name}`)}
                        <button
                            type="button"
                            class="flex w-full items-center gap-3 border-t px-4 py-2.5 text-left text-sm text-muted-foreground"
                            onclick={() => {
                                if (kind === "config")
                                    actions.selectConfig(
                                        data.resource.id,
                                        name,
                                    );
                                else if (kind === "metrics")
                                    actions.selectTab(card.id, "metrics");
                                else if (kind === "bind")
                                    actions.selectTab(card.id, "compose");
                                else
                                    actions.selectVolume(
                                        data.resource.id,
                                        name,
                                    );
                            }}
                        >
                            {#if kind === "config"}
                                <FileCog
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {:else if kind === "metrics"}
                                <ChartLine
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {:else if kind === "bind"}
                                <Folder
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {:else}
                                <HardDrive
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {/if}
                            <span class="truncate">{name}</span>
                        </button>
                    {/each}
                </div>
            {/each}
        </section>
    {/each}
</div>
