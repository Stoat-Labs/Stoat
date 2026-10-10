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

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let pending = $state(false);

    let canSubmit = $state(false);
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Cluster</DialogTitle>
            <DialogDescription>
                Clusters run your projects' resources.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <CreateClusterForm
                formId="create-cluster-form"
                bind:pending
                bind:canSubmit
                oncreated={() => {
                    open = false;
                }}
            />
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
                form="create-cluster-form"
                loading={pending}
                disabled={!canSubmit}
            >
                Create Cluster
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
