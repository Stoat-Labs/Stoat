<script lang="ts">
    import { cn } from "$lib/utils";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import Group from "@lucide/svelte/icons/group";
    import type { Node, NodeProps } from "@xyflow/svelte";
    import type { GroupData } from "./graph";
    import NodeHandles from "./node-handles.svelte";

    let { data, selected }: NodeProps<Node<GroupData, "stack">> =
        $props();
</script>

<NodeHandles />

<!-- Railway's default group: a faint grey wash, the card border colour, header 12px from the top. -->
<div
    class={cn(
        "size-full cursor-pointer rounded-xl border bg-muted-foreground/5 px-6 pt-3 transition-[border-color,box-shadow]",
        selected
            ? "border-foreground/24 shadow-[0_0_0_4px_--theme(--color-white/6%)]"
            : "border-foreground/14 hover:border-foreground/24",
    )}
>
    <header class="flex h-[26px] min-w-0 items-center gap-3">
        {#if data.icon}
            <img
                src={data.icon}
                alt=""
                aria-hidden="true"
                class="size-5 shrink-0 object-contain"
            />
        {:else}
            <Group class="size-5 shrink-0" aria-hidden="true" />
        {/if}
        <span
            class="min-w-0 flex-1 truncate text-base font-semibold"
            title={data.resource.name}
        >
            {data.resource.name}
        </span>
        <EllipsisVertical
            class="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
        />
    </header>
</div>
