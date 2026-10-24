<script lang="ts">
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import { cn } from "$lib/utils";
    import Box from "@lucide/svelte/icons/box";
    import FileCog from "@lucide/svelte/icons/file-cog";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import type { Node, NodeProps } from "@xyflow/svelte";
    import { getCanvasActions } from "../context";
    import {
        CARD_HEIGHT,
        VOLUME_OVERLAP,
        VOLUME_TRAY,
        type CardData,
    } from "../graph";
    import NodeHandles from "./node-handles.svelte";
    import ResourceStatus from "./resource-status.svelte";

    let { data, selected }: NodeProps<Node<CardData, "card">> =
        $props();

    const { resource, service, grouped, volume, config } =
        $derived(data);

    // Volume trays first, then config trays, one stack under the card.
    const trays = $derived([
        ...(service?.volumes ?? []).map((name) => ({
            kind: "volume",
            name,
        })),
        ...(service?.configs ?? []).map((name) => ({
            kind: "config",
            name,
        })),
    ]);

    const actions = getCanvasActions();

    // Railway shows one domain under the name; the rest are on the ingress page.
    const domain = $derived(service?.domains[0]);

    // The name being typed after a double-click; null when not editing.
    let draft = $state<string | null>(null);

    // Shown until the rename is saved and refetched, so the old name doesn't flash back.
    let saving = $state<string | null>(null);

    // A lone service is the resource, so it carries the resource's name.
    const title = $derived(
        grouped ? service?.name : (saving ?? resource.name),
    );

    function commit() {
        const name = draft?.trim();

        draft = null;

        if (!name) return;

        saving = name;
        void actions
            .rename(resource.id, name)
            .finally(() => (saving = null));
    }
</script>

<!-- Svelte Flow cancels mousedown on the pane, so the input never blurs; any press outside it saves. -->
<svelte:window
    onpointerdowncapture={(event) => {
        if (
            draft !== null &&
            !(
                event.target instanceof HTMLInputElement &&
                event.target.dataset.rename !== undefined
            )
        )
            commit();
    }}
/>

<NodeHandles />

<div class="group/card relative size-full cursor-pointer">
    {#if config}
        <!-- A config with no service: kept until it is deleted, like a volume. -->
        <div
            class={cn(
                "absolute inset-0 flex flex-col justify-between rounded-xl border bg-card p-6 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow]",
                selected
                    ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                    : "border-foreground/14 hover:border-foreground/24",
            )}
        >
            <div class="flex min-w-0 items-center gap-3">
                <FileCog
                    class="size-6 shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                />
                <p
                    class="truncate text-base font-semibold"
                    title={config.name}
                >
                    {config.name}
                </p>
            </div>
            <p class="truncate text-sm text-muted-foreground">
                Not mounted by any service
            </p>
        </div>
    {:else if volume}
        <!-- A volume with no service: kept until it is deleted, so its data stays reachable. -->
        <div
            class={cn(
                "absolute inset-0 flex flex-col justify-between rounded-xl border bg-card p-6 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow]",
                selected
                    ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                    : "border-foreground/14 hover:border-foreground/24",
            )}
        >
            <div class="flex min-w-0 items-center gap-3">
                <HardDrive
                    class="size-6 shrink-0"
                    strokeWidth={1.75}
                    aria-hidden="true"
                />
                <p
                    class="truncate text-base font-semibold"
                    title={volume.name}
                >
                    {volume.name}
                </p>
            </div>
            <p class="truncate text-sm text-muted-foreground">
                Not mounted by any service
            </p>
        </div>
    {:else}
        <!-- Railway's service card: 288×144, 24px padding, name on top and status pinned to the bottom. -->
        <div
            class={cn(
                "absolute inset-x-0 top-0 flex flex-col justify-between rounded-xl border bg-card p-6 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow]",
                selected
                    ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                    : "border-foreground/14 hover:border-foreground/24",
            )}
            style:height="{CARD_HEIGHT}px"
            style:z-index={trays.length + 1}
        >
            {#if service?.isNew}
                <!-- Railway's staged badge: in the draft, not deployed yet. -->
                <span
                    class="absolute top-2.5 right-2.5 rounded-sm bg-success/24 px-1.5 py-0.5 text-[10px] font-semibold text-success-foreground"
                >
                    New
                </span>
            {/if}
            <!-- Railway's header: 24px icon, then the name with the public domain beneath it. -->
            <div class="flex min-w-0 items-start gap-3">
                {#if data.icon}
                    <img
                        src={data.icon}
                        alt=""
                        aria-hidden="true"
                        class="size-6 shrink-0 object-contain"
                    />
                {:else if resource.type === "bucket"}
                    <BucketIcon
                        class="size-6 shrink-0"
                        aria-hidden="true"
                    />
                {:else}
                    <Box
                        class="size-6 shrink-0"
                        strokeWidth={1.75}
                        aria-hidden="true"
                    />
                {/if}
                <div class="flex min-w-0 flex-col">
                    {#if draft !== null}
                        <input
                            bind:value={draft}
                            data-rename
                            aria-label="Resource name"
                            maxlength={100}
                            {@attach (input) => {
                                // Svelte Flow keeps focus on the node, which would take the arrow keys; autofocus loses to it.
                                input.focus();
                                input.select();
                            }}
                            class="nodrag nopan w-full min-w-0 rounded-sm bg-transparent text-base font-semibold ring-1 ring-ring outline-none"
                            onblur={commit}
                            onkeydown={(event) => {
                                // Kept from the canvas, whose Escape closes the panel.
                                event.stopPropagation();
                                if (event.key === "Enter") commit();
                                if (event.key === "Escape")
                                    draft = null;
                            }}
                        />
                    {:else}
                        <!-- A grouped service's name lives in the Compose spec, so only a lone card renames inline. -->
                        <p
                            class="truncate text-base font-semibold"
                            {title}
                            data-renamable={!grouped || undefined}
                            ondblclick={(event) => {
                                if (grouped) return;
                                // Keeps Svelte Flow from zooming in on the double-click.
                                event.stopPropagation();
                                draft = resource.name;
                            }}
                        >
                            {title}
                        </p>
                    {/if}
                    {#if domain}
                        <p
                            class="truncate text-sm text-muted-foreground"
                            title={domain}
                        >
                            {domain}
                        </p>
                    {/if}
                </div>
            </div>
            {#if actions.isPendingDelete(resource.id)}
                <p
                    class="truncate text-sm text-destructive-foreground"
                >
                    Will be deleted
                </p>
            {:else if data.parseError}
                <p
                    class="truncate text-sm text-destructive-foreground"
                >
                    Compose spec can't be read
                </p>
            {:else}
                <!-- A stack deploys as one unit, so every service shares the resource's status. -->
                <ResourceStatus
                    {resource}
                    draftOnly={data.draftOnly}
                />
            {/if}
        </div>

        <!-- One tray per volume and config, each tucked 24px under the one above it. -->
        {#each trays as { kind, name }, index (`${kind}:${name}`)}
            <button
                type="button"
                class="group/volume absolute inset-x-0 flex cursor-pointer flex-col rounded-xl border border-foreground/14 bg-card text-left transition-colors hover:border-foreground/24 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                style:top="{CARD_HEIGHT -
                    VOLUME_OVERLAP +
                    index * (VOLUME_TRAY - VOLUME_OVERLAP)}px"
                style:height="{VOLUME_TRAY}px"
                style:z-index={trays.length - index}
                style:padding-top="{VOLUME_OVERLAP}px"
                data-volume={kind === "volume" ? name : undefined}
                data-config={kind === "config" ? name : undefined}
                onclick={(event) => {
                    event.stopPropagation();
                    if (kind === "config")
                        actions.selectConfig(resource.id, name);
                    else actions.selectVolume(resource.id, name);
                }}
            >
                <span
                    class="grid flex-1 grid-cols-[24px_1fr] items-center gap-3 px-6 text-sm text-muted-foreground group-hover/volume:text-foreground"
                >
                    {#if kind === "config"}
                        <FileCog class="size-4" aria-hidden="true" />
                    {:else}
                        <HardDrive
                            class="size-4"
                            aria-hidden="true"
                        />
                    {/if}
                    <span class="truncate" title={name}>{name}</span>
                </span>
            </button>
        {/each}
    {/if}
</div>
