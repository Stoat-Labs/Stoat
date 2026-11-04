<script lang="ts">
    import { goto } from "$app/navigation";
    import { Button } from "$lib/components/ui/button";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { isTerminalDeploymentStatus } from "$lib/deployments/status";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";

    let {
        clusterId,
        deploymentId,
        status,
    }: {
        clusterId: string;
        deploymentId: string;
        status: string;
    } = $props();

    // Members can't read the pending server, so the query fails and no retry shows.
    const pendingQuery = createQuery(() =>
        orpc.cluster.getPendingMachine.queryOptions({
            input: { clusterId },
            enabled:
                isTerminalDeploymentStatus(status) &&
                status !== "ready",
            staleTime: 0,
            retry: false,
        }),
    );

    const pending = $derived(pendingQuery.data);

    const startMutation = createMutation(() =>
        orpc.cluster.addMachine.mutationOptions({
            onSuccess: async (data) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getPendingMachine.queryKey(
                        {
                            input: { clusterId },
                        },
                    ),
                });
                await goto(`/deployments/${data.deploymentId}`);
            },
        }),
    );
</script>

{#if status === "ready"}
    <Button size="sm" href={`/clusters/${clusterId}`}>
        Open cluster
    </Button>
{:else if pending?.status === "failed" && pending.deploymentId === deploymentId}
    <Button
        size="sm"
        loading={startMutation.isPending}
        onclick={() => startMutation.mutate({ clusterId })}
    >
        Retry
    </Button>
    {#if startMutation.error}<span
            class="text-xs text-destructive-foreground"
        >
            {startMutation.error.message || "Unable to retry."}
        </span>{/if}
{/if}
