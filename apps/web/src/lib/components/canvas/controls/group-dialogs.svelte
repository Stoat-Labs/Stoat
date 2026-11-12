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
    import { getCanvasActions, type GroupAction } from "../context";
    import type { CanvasGroup, CanvasResource } from "../graph";
    import TransferDialog from "./transfer-dialog.svelte";

    let {
        projectId,
        action,
        group,
        resource,
        onclose,
    }: {
        projectId: string;
        /** Undefined closes every dialog. */
        action: GroupAction | undefined;
        /** The frame whose menu opened rename or an icon dialog. */
        group: CanvasGroup | undefined;
        /** The card whose menu opened rename, a new group or a transfer. */
        resource: CanvasResource | undefined;
        onclose: () => void;
    } = $props();

    const actions = getCanvasActions();

    // Rename edits the group's or the resource's name; New group names the group it creates around the resource.
    const naming = $derived(
        (action === "rename" &&
            (group !== undefined || resource !== undefined)) ||
            (action === "new-group" && resource !== undefined),
    );

    let name = $state("");

    let saving = $state(false);

    let error = $state("");

    // Kept while the dialog fades out, when `action` is already cleared.
    let renaming = $state(false);

    let renamed = $state("");

    $effect(() => {
        if (action === "rename") {
            renamed = group?.name ?? resource?.name ?? "";
            name = renamed;
            renaming = true;
        } else if (action === "new-group") {
            name = "";
            renaming = false;
        }
    });

    async function refresh() {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: orpc.resources.listGroups.key(),
            }),
            queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            }),
        ]);
    }

    // updateGroup replaces both fields, so the one not being edited is sent unchanged.
    async function updateIcon(icon: string) {
        if (!group) return;

        await client.resources.updateGroup({
            projectId,
            groupId: group.id,
            name: group.name,
            icon,
        });
        await refresh();
    }

    async function save() {
        saving = true;
        error = "";

        try {
            if (action === "rename" && group)
                await client.resources.updateGroup({
                    projectId,
                    groupId: group.id,
                    name: name.trim(),
                    icon: group.icon ?? undefined,
                });
            else if (action === "rename" && resource)
                await actions.rename(resource.id, name.trim());
            else if (resource)
                await client.resources.createGroup({
                    projectId,
                    name: name.trim(),
                    resourceIds: [resource.id],
                });

            await refresh();
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
        () => naming,
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
                void save();
            }}
        >
            <DialogHeader>
                <DialogTitle>
                    {renaming ? `Rename ${renamed}` : "New group"}
                </DialogTitle>
            </DialogHeader>
            <DialogPanel class="space-y-3">
                <Input
                    bind:value={name}
                    aria-label={group || action === "new-group"
                        ? "Group name"
                        : "Resource name"}
                    placeholder="Backend"
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
                    {renaming ? "Save" : "Create"}
                </Button>
            </DialogFooter>
        </form>
    </DialogContent>
</Dialog>

{#if resource && (action === "move" || action === "copy")}
    <TransferDialog mode={action} {projectId} {resource} {onclose} />
{:else if resource && action === "duplicate"}
    <TransferDialog
        mode="copy"
        duplicate
        {projectId}
        {resource}
        {onclose}
    />
{/if}

<ResourceIconUploadDialog
    bind:open={
        () => action === "icon-upload" && group !== undefined,
        (open) => {
            if (!open) onclose();
        }
    }
    onselect={updateIcon}
/>

<ResourceIconLinkDialog
    bind:open={
        () => action === "icon-link" && group !== undefined,
        (open) => {
            if (!open) onclose();
        }
    }
    currentIcon={group?.icon ?? ""}
    onselect={updateIcon}
/>
