<script lang="ts">
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
    import InitializeClusterForm from "./initialize-cluster-form.svelte";

    let {
        open = $bindable(false),
        clusterId,
        mode = "initialize",
        onInitialized,
    }: {
        open?: boolean;
        clusterId: string;
        mode?: "initialize" | "reinitialize";
        onInitialized?: (
            deploymentId: string,
            originatingClusterId: string,
        ) => void;
    } = $props();

    let pending = $state(false);

    let ready = $state(false);

    let canSubmit = $state(false);

    const isReinitialize = $derived(mode === "reinitialize");
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-lg">
        <DialogHeader>
            <DialogTitle>
                {isReinitialize
                    ? "Reinitialize cluster monitoring"
                    : "Initialize cluster monitoring"}
            </DialogTitle>
            <DialogDescription>
                Deploy the internal monitoring stack. No public ports
                or ingress routes are created.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            <InitializeClusterForm
                formId="initialize-cluster-form"
                {clusterId}
                {mode}
                bind:pending
                bind:ready
                bind:canSubmit
                oninitialized={(
                    deploymentId,
                    originatingClusterId,
                ) => {
                    if (clusterId === originatingClusterId)
                        open = false;
                    onInitialized?.(
                        deploymentId,
                        originatingClusterId,
                    );
                }}
            />
        </DialogPanel>

        {#if ready}
            <DialogFooter>
                <Button
                    variant="outline"
                    disabled={pending}
                    onclick={() => {
                        open = false;
                    }}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    form="initialize-cluster-form"
                    loading={pending}
                    disabled={!canSubmit}
                >
                    {isReinitialize
                        ? "Save and reinitialize"
                        : "Initialize monitoring"}
                </Button>
            </DialogFooter>
        {/if}
    </DialogContent>
</Dialog>
