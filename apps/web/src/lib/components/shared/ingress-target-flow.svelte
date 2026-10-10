<script lang="ts">
    import {
        Flow,
        FlowNode,
        FlowParallel,
    } from "$lib/components/flow";
    import Globe from "@lucide/svelte/icons/globe";
    import Server from "@lucide/svelte/icons/server";

    let {
        hosts,
        service,
        port,
    }: {
        hosts: string[];
        service: string;
        port?: number;
    } = $props();
</script>

<div style:min-height={`${Math.max(160, hosts.length * 64 + 64)}px`}>
    <Flow orientation="horizontal" align="start">
        <FlowParallel align="end">
            {#each hosts as host (host)}
                <FlowNode class="whitespace-nowrap font-mono text-sm">
                    <span class="flex items-center gap-2">
                        <Globe
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        {host}
                    </span>
                </FlowNode>
            {/each}
        </FlowParallel>
        <FlowNode class="whitespace-nowrap font-mono text-xs">
            <span class="flex items-center gap-2">
                <Server
                    class="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
                {service}{port === undefined ? "" : `:${port}`}
            </span>
        </FlowNode>
    </Flow>
</div>
