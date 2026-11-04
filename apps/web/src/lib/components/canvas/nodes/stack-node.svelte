<script lang="ts">
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuSub,
        MenuSubPopup,
        MenuSubTrigger,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { cn } from "$lib/utils";
    import Box from "@lucide/svelte/icons/box";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import Group from "@lucide/svelte/icons/group";
    import type { Node, NodeProps } from "@xyflow/svelte";
    import { orpc } from "$lib/api/orpc";
    import { containerInfo } from "$lib/resources/container-info";
    import { createQuery } from "@tanstack/svelte-query";
    import { getCanvasActions, getCanvasCluster } from "../context";
    import type { GroupData } from "../graph";
    import NodeHandles from "./node-handles.svelte";

    let { id, data, selected }: NodeProps<Node<GroupData, "stack">> =
        $props();

    const actions = getCanvasActions();

    const cluster = getCanvasCluster();

    // Same project-wide query as the cards, so a collapsed group adds no polling.
    const containersQuery = createQuery(() =>
        orpc.resources.getProjectContainers.queryOptions({
            input: {
                clusterId: cluster.id,
                projectId: data.projectId,
            },
            enabled: cluster.id.length > 0,
            refetchInterval: 30_000,
        }),
    );

    // A resource is online while one of its containers runs and is not unhealthy.
    const online = $derived(
        data.resources.filter((resource) =>
            (containersQuery.data?.[resource.resourceId] ?? []).some(
                ({ container }) => {
                    const info = containerInfo(container);

                    return (
                        info.status === "running" &&
                        info.health !== "unhealthy"
                    );
                },
            ),
        ).length,
    );

    const allOnline = $derived(
        online > 0 && online === data.resources.length,
    );
</script>

<NodeHandles />

{#snippet icon(size: string)}
    {#if data.icon}
        <img
            src={data.icon}
            alt=""
            aria-hidden="true"
            class={cn(size, "shrink-0 object-contain")}
        />
    {:else}
        <Group class={cn(size, "shrink-0")} aria-hidden="true" />
    {/if}
{/snippet}

<!-- Railway's group ⋮ menu, minus Colour and nesting. -->
{#snippet menu()}
    <Menu>
        <MenuTrigger
            class="nodrag nopan flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            aria-label="{data.name} options"
            onpointerdown={(event: PointerEvent) =>
                event.stopPropagation()}
            onclick={(event: MouseEvent) => event.stopPropagation()}
        >
            <EllipsisVertical
                class="size-[18px]"
                aria-hidden="true"
            />
        </MenuTrigger>
        <MenuPopup align="end" class="min-w-52">
            {#if data.group}
                <MenuItem onclick={() => actions.edit("rename", id)}>
                    Rename
                </MenuItem>
                <MenuSub>
                    <MenuSubTrigger>Update icon</MenuSubTrigger>
                    <MenuSubPopup>
                        <MenuItem
                            onclick={() =>
                                actions.edit("icon-upload", id)}
                        >
                            Upload image
                        </MenuItem>
                        <MenuItem
                            onclick={() =>
                                actions.edit("icon-link", id)}
                        >
                            Use a link
                        </MenuItem>
                    </MenuSubPopup>
                </MenuSub>
            {:else}
                <!-- A resource's own frame: grouping it swaps this frame for the group's. -->
                <MenuItem
                    onclick={() => actions.edit("new-group", id)}
                >
                    New group
                </MenuItem>
            {/if}
            <MenuItem onclick={() => actions.toggleCollapsed(id)}>
                {data.collapsed ? "Show contents" : "Hide contents"}
            </MenuItem>
            {#if data.group}
                <!-- Railway's "Remove Group": the frame goes, its resources stay. -->
                <MenuItem onclick={() => actions.ungroup(id)}>
                    Remove Group
                </MenuItem>
            {/if}
        </MenuPopup>
    </Menu>
{/snippet}

{#if data.collapsed}
    <!-- Railway's collapsed group: 288×264, its resources' icons in an inset box, a status line. -->
    <div
        class={cn(
            "flex size-full cursor-pointer flex-col justify-between rounded-xl border bg-card px-6 py-3 transition-[border-color,box-shadow]",
            data.dropTarget
                ? "border-foreground/40"
                : selected
                  ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                  : "border-foreground/14 hover:border-foreground/24",
        )}
    >
        <header class="flex h-[26px] min-w-0 items-center gap-3">
            {@render icon("size-6")}
            <span
                class="min-w-0 flex-1 truncate text-base font-semibold"
                title={data.name}
            >
                {data.name}
            </span>
            {@render menu()}
        </header>
        <div
            class="my-3 flex flex-1 items-center justify-center rounded-lg border border-foreground/14 bg-foreground/[0.03] p-0.5"
        >
            <div
                class="flex flex-wrap items-center justify-center gap-2"
            >
                {#each data.resources as resource (resource.id)}
                    <span
                        class="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-muted"
                        title={resource.name}
                    >
                        {#if resource.icon}
                            <img
                                src={resource.icon}
                                alt=""
                                aria-hidden="true"
                                class="size-[19px] object-contain"
                            />
                        {:else}
                            <Box
                                class="size-[19px]"
                                aria-hidden="true"
                            />
                        {/if}
                    </span>
                {/each}
            </div>
        </div>
        <p
            class={cn(
                "flex items-center gap-2 text-sm",
                allOnline
                    ? "text-success-foreground"
                    : "text-muted-foreground",
            )}
        >
            {#if allOnline}
                <svg
                    class="size-4"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                >
                    <circle cx="8" cy="8" r="3" fill="currentColor" />
                </svg>
            {/if}
            {online}/{data.resources.length}
            {data.group ? "resources" : "services"} online
        </p>
    </div>
{:else}
    <!-- Railway's default group: a faint grey wash, the card border colour, header 12px from the top. -->
    <div
        class={cn(
            "size-full cursor-pointer rounded-xl border bg-muted-foreground/5 px-6 pt-3 transition-[border-color,box-shadow]",
            // Railway lightens a frame while a card from elsewhere hovers it.
            data.dropTarget
                ? "border-foreground/40 bg-muted-foreground/12"
                : selected
                  ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                  : "border-foreground/14 hover:border-foreground/24",
        )}
    >
        <header class="flex h-[26px] min-w-0 items-center gap-3">
            {@render icon("size-5")}
            <span
                class="min-w-0 flex-1 truncate text-base font-semibold"
                title={data.name}
            >
                {data.name}
            </span>
            {@render menu()}
        </header>
    </div>
{/if}
