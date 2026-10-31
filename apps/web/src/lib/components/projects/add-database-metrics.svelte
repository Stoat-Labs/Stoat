<script lang="ts">
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { createMutation } from "@tanstack/svelte-query";

    let {
        projectId,
        resourceId,
        label,
    }: {
        projectId: string;
        resourceId: string;
        label: string;
    } = $props();

    let open = $state(false);

    const mutation = createMutation(() =>
        orpc.resources.addDatabaseMetrics.mutationOptions({
            onSuccess: async () => {
                // The graph shows the new draft exporter, which also hides this prompt.
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });
                open = false;
            },
        }),
    );

    function show() {
        mutation.reset();
        open = true;
    }
</script>

<Alert variant="info">
    <AlertDescription>
        {label} metrics such as connections, queries and cache hits are
        not collected for this database.
    </AlertDescription>
    <AlertAction>
        <Button size="sm" variant="outline" onclick={show}>
            Add metrics
        </Button>
    </AlertAction>
</Alert>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Add {label} metrics</DialogTitle>
            <DialogDescription>
                Adds an exporter resource that connects to this
                database through variable references. Deploy it to
                start collecting.
            </DialogDescription>
        </DialogHeader>
        {#if mutation.error}
            <DialogPanel>
                <Alert variant="error">
                    <AlertDescription>
                        {mutation.error.message ||
                            "Unable to add metrics."}
                    </AlertDescription>
                </Alert>
            </DialogPanel>
        {/if}
        <DialogFooter>
            <Button
                variant="outline"
                disabled={mutation.isPending}
                onclick={() => (open = false)}
            >
                Cancel
            </Button>
            <Button
                loading={mutation.isPending}
                onclick={() =>
                    mutation.mutate({ projectId, resourceId })}
            >
                Add metrics
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
