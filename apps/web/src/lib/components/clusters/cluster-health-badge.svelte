<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import { Badge } from "$lib/components/ui/badge";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { createQuery } from "@tanstack/svelte-query";

    let { clusterId }: { clusterId: string } = $props();

    // Each row asks its own sidecar, so one slow cluster never holds back the list.
    // Same options as the home page, which shares this cache.
    const health = createQuery(() =>
        orpc.cluster.healthz.queryOptions({
            input: { clusterId },
            refetchInterval: 60_000,
            staleTime: 30_000,
            retry: false,
        }),
    );
</script>

{#if health.isPending}
    <Skeleton loading loading-label="Checking cluster health">
        <Badge variant="secondary">Checking</Badge>
    </Skeleton>
{:else if health.data?.status === "healthy"}
    <Badge variant="success">Healthy</Badge>
{:else if health.data?.status === "degraded"}
    <Badge variant="warning">Degraded</Badge>
{:else}
    <Badge variant="secondary">Unknown</Badge>
{/if}
