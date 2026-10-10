<script lang="ts">
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { createMutation } from "@tanstack/svelte-query";

    let {
        projectId,
        resourceId,
        name,
    }: { projectId: string; resourceId: string; name: string } =
        $props();

    let deleteOpen = $state(false);

    const removeState = createMutation(() =>
        orpc.resources.deleteResource.mutationOptions({
            onSuccess: async () => {
                deleteOpen = false;
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey:
                            orpc.resources.listResources.queryKey({
                                input: { projectId },
                            }),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.projects.key(),
                    }),
                ]);
                await goto(`/projects/${projectId}`);
            },
        }),
    );
</script>

{#if page.data.isOrganizationAdmin}
    <section
        class="grid gap-5 md:grid-cols-3 md:gap-8"
        aria-labelledby="resource-danger-zone-heading"
    >
        <div>
            <h2
                id="resource-danger-zone-heading"
                class="text-lg font-semibold leading-tight tracking-tight"
            >
                Danger zone
            </h2>
            <p
                class="mt-1 text-sm leading-relaxed text-muted-foreground"
            >
                Irreversible actions for this resource.
            </p>
        </div>

        <div class="md:col-span-2">
            <Card>
                <CardPanel
                    class="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"
                >
                    <div class="min-w-0 space-y-1">
                        <h3 class="text-sm font-medium">
                            Delete resource
                        </h3>
                        <p class="text-sm text-muted-foreground">
                            Stop its services on the cluster and
                            remove it from the project.
                        </p>
                    </div>
                    <Button
                        variant="destructive"
                        onclick={() => {
                            removeState.reset();
                            deleteOpen = true;
                        }}
                    >
                        Delete resource
                    </Button>
                </CardPanel>
            </Card>
        </div>
    </section>
{/if}

<ConfirmDialog
    bind:open={deleteOpen}
    title={`Delete ${name}?`}
    description="Its services are removed from the cluster and its deployment history is deleted. Volumes stay on the machines. This cannot be undone."
    confirmLabel="Delete resource"
    pending={removeState.isPending}
    error={removeState.error?.message ?? ""}
    onconfirm={() => removeState.mutate({ projectId, resourceId })}
/>
