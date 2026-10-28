<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { getCanvasActions } from "../../context";
    import type { CanvasResource } from "../../graph";

    let {
        resource,
        isBucket,
    }: { resource: CanvasResource; isBucket: boolean } = $props();

    const actions = getCanvasActions();

    const pendingDelete = $derived(
        actions.isPendingDelete(resource.id),
    );
</script>

<div>
    <h4 class="text-sm font-medium text-destructive-foreground">
        {isBucket ? "Delete Bucket" : "Delete Resource"}
    </h4>
    <p class="mt-1 text-sm text-destructive-foreground">
        {#if pendingDelete}
            Staged for deletion. Deploying the staged changes removes
            it.
        {:else if isBucket}
            Revokes this bucket's keys and removes it from the project
            once you apply the change. A bucket that still holds
            objects is kept at the provider.
        {:else}
            Stops its services on the cluster and removes it from the
            project once you apply the change.
        {/if}
    </p>
    {#if pendingDelete}
        <Button
            variant="outline"
            class="mt-4"
            onclick={() => actions.restore(resource.id)}
        >
            Undo delete
        </Button>
    {:else}
        <Button
            variant="destructive"
            class="mt-4"
            onclick={() => actions.remove(resource.id)}
        >
            {isBucket ? "Delete bucket" : "Delete resource"}
        </Button>
    {/if}
</div>
