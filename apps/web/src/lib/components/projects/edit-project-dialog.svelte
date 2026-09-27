<script lang="ts">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
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
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/orpc";
    import { createMutation } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let {
        open = $bindable(false),
        project,
    }: { open?: boolean; project: { id: string; name: string; description: string | null } } = $props();

    let name = $state("");

    let description = $state("");

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (!isOpen || wasOpen === true) return;
            name = project.name;
            description = project.description ?? "";
            mutation.reset();
        },
    );

    const mutation = createMutation(() =>
        orpc.projects.updateProject.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({ queryKey: orpc.projects.key() });
                open = false;
            },
        }),
    );

    function submit(event: SubmitEvent) {
        event.preventDefault();

        if (mutation.isPending) return;
        mutation.mutate({
            projectId: project.id,
            name: name.trim(),
            description: description.trim() || undefined,
        });
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>Update the project's name and description.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if mutation.error}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>{mutation.error.message || "Unable to update project."}</AlertDescription>
                </Alert>
            {/if}
            <form id="edit-project-form" method="POST" onsubmit={submit} class="space-y-4" aria-busy={mutation.isPending}>
                <Field>
                    <Label for="edit-project-name" required>Name</Label>
                    <Input
                        id="edit-project-name"
                        bind:value={name}
                        required
                        maxlength={100}
                        disabled={mutation.isPending}
                    />
                </Field>
                <Field>
                    <Label for="edit-project-description">Description</Label>
                    <Textarea
                        id="edit-project-description"
                        bind:value={description}
                        placeholder="What is this project for?"
                        maxlength={500}
                        rows={3}
                        disabled={mutation.isPending}
                    />
                </Field>
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" disabled={mutation.isPending} onclick={() => (open = false)}>
                Cancel
            </Button>
            <Button
                type="submit"
                form="edit-project-form"
                loading={mutation.isPending}
                disabled={!name.trim() || mutation.isPending}
            >
                Save
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
