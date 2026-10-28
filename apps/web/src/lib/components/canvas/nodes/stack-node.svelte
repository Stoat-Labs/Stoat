<script lang="ts">
    import {
        Menu,
        MenuItem,
        MenuLinkItem,
        MenuPopup,
        MenuSeparator,
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
    import { getCanvasActions } from "../context";
    import type { GroupData } from "../graph";
    import NodeHandles from "./node-handles.svelte";

    let { data, selected }: NodeProps<Node<GroupData, "stack">> =
        $props();

    const actions = getCanvasActions();

    const online = $derived(
        data.resource.deploymentStatus === "ready",
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

<!-- Railway's group ⋮ menu, minus Colour and nesting, which Stoat resources don't have. -->
{#snippet menu()}
    <Menu>
        <MenuTrigger
            class="nodrag nopan flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
            aria-label="{data.resource.name} options"
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
            <MenuItem
                onclick={() =>
                    actions.edit("rename", data.resource.id)}
            >
                Rename
            </MenuItem>
            <MenuSub>
                <MenuSubTrigger>Update icon</MenuSubTrigger>
                <MenuSubPopup>
                    <MenuItem
                        onclick={() =>
                            actions.edit(
                                "icon-upload",
                                data.resource.id,
                            )}
                    >
                        Upload image
                    </MenuItem>
                    <MenuItem
                        onclick={() =>
                            actions.edit(
                                "icon-link",
                                data.resource.id,
                            )}
                    >
                        Use a link
                    </MenuItem>
                </MenuSubPopup>
            </MenuSub>
            <MenuItem
                onclick={() =>
                    actions.toggleCollapsed(data.resource.id)}
            >
                {data.collapsed ? "Show contents" : "Hide contents"}
            </MenuItem>
            <!-- Railway's "Remove Group": the services stay, each as a resource of its own. -->
            <MenuItem
                onclick={() => actions.ungroup(data.resource.id)}
            >
                Remove Group
            </MenuItem>
            <MenuSeparator />
            <MenuItem
                onclick={() =>
                    actions.edit("duplicate", data.resource.id)}
            >
                Duplicate…
            </MenuItem>
            <MenuItem
                onclick={() => actions.edit("move", data.resource.id)}
            >
                Move to Project…
            </MenuItem>
            <MenuItem
                onclick={() => actions.edit("copy", data.resource.id)}
            >
                Copy to Project…
            </MenuItem>
            <MenuSeparator />
            <MenuLinkItem
                href="/projects/{data.resource.projectId}/{data
                    .resource.id}"
            >
                Open resource page
            </MenuLinkItem>
        </MenuPopup>
    </Menu>
{/snippet}

{#if data.collapsed}
    <!-- Railway's collapsed group: 288×264, its services' icons in an inset box, a status line. -->
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
                title={data.resource.name}
            >
                {data.resource.name}
            </span>
            {@render menu()}
        </header>
        <div
            class="my-3 flex flex-1 items-center justify-center rounded-lg border border-foreground/14 bg-foreground/[0.03] p-0.5"
        >
            <div
                class="flex flex-wrap items-center justify-center gap-2"
            >
                {#each data.services as service (service.name)}
                    <span
                        class="flex size-10 items-center justify-center rounded-lg border border-white/10 bg-muted"
                        title={service.name}
                    >
                        {#if service.icon}
                            <img
                                src={service.icon}
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
                online
                    ? "text-success-foreground"
                    : "text-muted-foreground",
            )}
        >
            {#if online}
                <svg
                    class="size-4"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                >
                    <circle cx="8" cy="8" r="3" fill="currentColor" />
                </svg>
            {/if}
            {online ? data.serviceCount : 0}/{data.serviceCount} services
            online
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
                title={data.resource.name}
            >
                {data.resource.name}
            </span>
            {@render menu()}
        </header>
    </div>
{/if}
