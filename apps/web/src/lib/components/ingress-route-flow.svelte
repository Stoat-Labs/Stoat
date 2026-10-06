<script lang="ts">
    import {
        Flow,
        FlowNode,
        FlowNodeList,
        FlowParallel,
    } from "$lib/components/flow";
    import Globe from "@lucide/svelte/icons/globe";
    import Server from "@lucide/svelte/icons/server";

    let {
        host,
        items,
    }: {
        host: string | null;
        items: {
            key: string;
            service: string;
            path: string;
            port?: number;
        }[];
    } = $props();
</script>

<div style:min-height={`${Math.max(160, items.length * 64 + 64)}px`}>
    <Flow orientation="horizontal" align="start">
        <FlowNode class="whitespace-nowrap font-mono text-sm">
            <span class="flex items-center gap-2">
                <Globe
                    class="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
                {host ?? "Cluster-assigned domain"}
            </span>
        </FlowNode>
        <FlowParallel>
            {#each items as item (item.key)}
                <FlowNodeList>
                    <FlowNode
                        class="w-40 whitespace-nowrap font-mono text-xs"
                    >
                        {item.path}
                    </FlowNode>
                    <FlowNode
                        class="whitespace-nowrap font-mono text-xs"
                    >
                        <span class="flex items-center gap-2">
                            <Server
                                class="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            {item.service}{item.port === undefined
                                ? ""
                                : `:${item.port}`}
                        </span>
                    </FlowNode>
                </FlowNodeList>
            {/each}
        </FlowParallel>
    </Flow>
</div>
