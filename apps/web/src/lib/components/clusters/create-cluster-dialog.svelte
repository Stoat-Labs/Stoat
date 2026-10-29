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
    import CreateClusterForm from "./create-cluster-form.svelte";
    import ProvisionClusterForm from "./provision-cluster-form.svelte";

    let {
        open = $bindable(false),
        source = "connect",
        onprovision,
    }: {
        open?: boolean;
        source?: "connect" | "server";
        onprovision: (clusterId: string) => void;
    } = $props();

    let pending = $state(false);

    let canSubmit = $state(false);
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>
                {source === "server"
                    ? "Create Cluster on a New Server"
                    : "Connect Existing Cluster"}
            </DialogTitle>
            <DialogDescription>
                Clusters run your projects' resources.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if source === "server"}
                <ProvisionClusterForm
                    formId="provision-cluster-form"
                    bind:pending
                    bind:canSubmit
                    oncreated={onprovision}
                />
            {:else}
                <CreateClusterForm
                    formId="create-cluster-form"
                    bind:pending
                    bind:canSubmit
                    oncreated={() => {
                        open = false;
                    }}
                />
            {/if}
        </DialogPanel>
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
                form={source === "server"
                    ? "provision-cluster-form"
                    : "create-cluster-form"}
                loading={pending}
                disabled={!canSubmit}
            >
                {source === "server" ? "Continue" : "Create Cluster"}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
