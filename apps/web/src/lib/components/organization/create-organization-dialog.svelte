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
    import CreateOrganizationForm from "./create-organization-form.svelte";

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let pending = $state(false);
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>
                Add a new organization to manage projects and team
                members.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <CreateOrganizationForm
                formId="create-organization-form"
                bind:pending
                oncreated={() => window.location.assign("/")}
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
                form="create-organization-form"
                loading={pending}
            >
                Create Organization
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
