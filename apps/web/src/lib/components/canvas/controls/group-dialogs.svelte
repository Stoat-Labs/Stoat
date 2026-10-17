<script lang="ts">
    import ResourceIconLinkDialog from "$lib/components/projects/resource-icon-link-dialog.svelte";
    import ResourceIconUploadDialog from "$lib/components/projects/resource-icon-upload-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Input } from "$lib/components/ui/input";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import type { GroupAction } from "../context";
    import type { CanvasResource } from "../graph";
    import TransferDialog from "./transfer-dialog.svelte";

    let {
        projectId,
        resource,
        action,
        onclose,
    }: {
        projectId: string;
        /** The frame whose ⋮ menu opened this; undefined closes every dialog. */
        resource: CanvasResource | undefined;
        action: GroupAction | undefined;
        onclose: () => void;
    } = $props();

    let name = $state("");

    let saving = $state(false);

    let error = $state("");

    $effect(() => {
        if (action === "rename" && resource) name = resource.name;
    });

    // updateDetails replaces all three fields, so the ones not being edited are sent unchanged.
    async function update(changes: { name?: string; icon?: string }) {
        if (!resource) return;

        await client.resources.updateDetails({
            projectId,
            resourceId: resource.id,
            name: changes.name ?? resource.name,
            description: resource.description ?? undefined,
            icon: changes.icon ?? resource.icon ?? undefined,
        });
        await queryClient.invalidateQueries({
            queryKey: orpc.resources.listResources.key(),
        });
    }

    async function rename() {
        saving = true;
        error = "";

        try {
            await update({ name: name.trim() });
            onclose();
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Could not save.";
        } finally {
            saving = false;
        }
    }
</script>

<Dialog
    bind:open={
        () => action === "rename" && resource !== undefined,
        (open) => {
            if (!open) onclose();
        }
    }
>
    <DialogContent class="max-w-md">
        <form
            class="contents"
            onsubmit={(event) => {
                event.preventDefault();
                void rename();
            }}
        >
            <DialogHeader>
                <DialogTitle>Rename {resource?.name}</DialogTitle>
            </DialogHeader>
            <DialogPanel class="space-y-3">
                <Input
                    bind:value={name}
                    aria-label="Resource name"
                    maxlength={100}
                    autofocus
                />
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
            </DialogPanel>
            <DialogFooter>
                <Button
                    variant="outline"
                    type="button"
                    onclick={onclose}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    loading={saving}
                    disabled={saving || !name.trim()}
                >
                    Save
                </Button>
            </DialogFooter>
        </form>
    </DialogContent>
</Dialog>

{#if resource && (action === "move" || action === "copy")}
    <TransferDialog mode={action} {projectId} {resource} {onclose} />
{/if}

<ResourceIconUploadDialog
    bind:open={
        () => action === "icon-upload" && resource !== undefined,
        (open) => {
            if (!open) onclose();
        }
    }
    onselect={(icon) => update({ icon })}
/>

<ResourceIconLinkDialog
    bind:open={
        () => action === "icon-link" && resource !== undefined,
        (open) => {
            if (!open) onclose();
        }
    }
    currentIcon={resource?.icon ?? ""}
    onselect={(icon) => update({ icon })}
/>
