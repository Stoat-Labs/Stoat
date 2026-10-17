<script lang="ts">
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import { cn } from "$lib/utils";
    import Box from "@lucide/svelte/icons/box";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import type { Node, NodeProps } from "@xyflow/svelte";
    import {
        CARD_HEIGHT,
        VOLUME_OVERLAP,
        type CardData,
    } from "../graph";
    import NodeHandles from "./node-handles.svelte";
    import ResourceStatus from "./resource-status.svelte";

    let { data, selected }: NodeProps<Node<CardData, "card">> =
        $props();

    const { resource, service, grouped } = $derived(data);

    // Railway shows one domain under the name; the rest are on the ingress page.
    const domain = $derived(service?.domains[0]);

    // A lone service is the resource, so it carries the resource's name.
    const title = $derived(grouped ? service?.name : resource.name);
</script>

<NodeHandles />

<div class="group/card relative size-full cursor-pointer">
    <!-- Railway's service card: 288×144, 24px padding, name on top and status pinned to the bottom. -->
    <div
        class={cn(
            "absolute inset-x-0 top-0 z-[1] flex flex-col justify-between rounded-xl border bg-card p-6 text-card-foreground shadow-xs/5 transition-[border-color,box-shadow]",
            selected
                ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
                : "border-foreground/14 group-hover/card:border-foreground/24",
        )}
        style:height="{CARD_HEIGHT}px"
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
                <p class="truncate text-base font-semibold" {title}>
                    {title}
                </p>
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
        {#if data.parseError}
            <p class="truncate text-sm text-destructive-foreground">
                Compose spec can't be read
            </p>
        {:else}
            <!-- A stack deploys as one unit, so every service shares the resource's status. -->
            <ResourceStatus {resource} draftOnly={data.draftOnly} />
        {/if}
    </div>

    {#if service?.volumes.length}
        <!-- Railway's volume tray: tucked 24px under the card, showing the volume below it. -->
        <div
            class="absolute inset-x-0 bottom-0 flex flex-col rounded-xl border border-foreground/14 bg-card"
            style:top="{CARD_HEIGHT - VOLUME_OVERLAP}px"
            style:padding-top="{VOLUME_OVERLAP}px"
        >
            <div
                class="grid flex-1 grid-cols-[24px_1fr] items-center gap-3 px-6 text-sm text-muted-foreground"
            >
                <HardDrive class="size-4" aria-hidden="true" />
                <span
                    class="truncate"
                    title={service.volumes.join(", ")}
                >
                    {service.volumes.join(", ")}
                </span>
            </div>
        </div>
    {/if}
</div>
