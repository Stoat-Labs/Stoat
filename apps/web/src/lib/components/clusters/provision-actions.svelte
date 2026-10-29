<script lang="ts">
    import { goto } from "$app/navigation";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
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

    let confirmReset = $state(false);

    // Members can't read setup state, so the query fails and no action shows.
    const provisionQuery = createQuery(() =>
        orpc.cluster.getProvisioning.queryOptions({
            input: { clusterId },
            enabled: isTerminalDeploymentStatus(status),
            staleTime: 0,
            retry: false,
        }),
    );

    const provision = $derived(provisionQuery.data);

    const startMutation = createMutation(() =>
        orpc.cluster.startProvisioning.mutationOptions({
            onSuccess: async (data) => {
                confirmReset = false;
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listClusters.queryKey(),
                });
                await goto(`/deployments/${data.deploymentId}`);
            },
        }),
    );

    function retry(reset = false) {
        // A half-created cluster is only reset after an explicit confirmation.
        if (provision?.setup?.initState === "partial" && !reset) {
            confirmReset = true;

            return;
        }

        startMutation.mutate({ clusterId, reset });
    }
</script>

{#if provision?.status === "ready"}
    <Button size="sm" href={`/clusters/${clusterId}`}>
        Open cluster
    </Button>
{:else if provision?.status === "failed" && provision.deploymentId === deploymentId}
    <Button
        size="sm"
        loading={startMutation.isPending && !confirmReset}
        onclick={() => retry()}
    >
        Retry setup
    </Button>
    {#if startMutation.error && !confirmReset}<span
            class="text-xs text-destructive-foreground"
        >
            {startMutation.error.message || "Unable to retry."}
        </span>{/if}
{/if}

<ConfirmDialog
    bind:open={confirmReset}
    title="Reset the server?"
    description={`The last attempt created a cluster on ${provision?.setup?.host ?? "this server"} but didn't finish setting it up. Retrying resets Uncloud on the server and removes its containers.`}
    confirmLabel="Reset and retry"
    pending={startMutation.isPending}
    error={startMutation.error?.message ?? ""}
    onconfirm={() => retry(true)}
/>
