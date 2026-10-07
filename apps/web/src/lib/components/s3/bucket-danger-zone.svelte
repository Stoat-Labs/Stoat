<script lang="ts">
    import { goto } from "$app/navigation";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";

    let {
        projectId,
        resourceId,
        name,
    }: { projectId: string; resourceId: string; name: string } =
        $props();

    const input = $derived({ projectId, resourceId });

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({ input, retry: false }),
    );

    const busy = $derived(
        bucketQuery.data?.status === "provisioning" ||
            bucketQuery.data?.status === "deleting",
    );

    let deleteOpen = $state(false);

    // The overview follows the deletion job and leaves once the bucket is gone.
    const removeState = createMutation(() =>
        orpc.buckets.remove.mutationOptions({
            onSuccess: async () => {
                deleteOpen = false;
                await queryClient.invalidateQueries({
                    queryKey: orpc.buckets.get.queryKey({ input }),
                });
                await goto(`/projects/${projectId}/${resourceId}`);
            },
        }),
    );
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="danger-zone-heading"
>
    <div>
        <h2
            id="danger-zone-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            Danger zone
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Irreversible actions for this bucket.
        </p>
    </div>

    <div class="md:col-span-2">
        <Card>
            <CardPanel
                class="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"
            >
                <div class="min-w-0 space-y-1">
                    <h3 class="text-sm font-medium">Delete bucket</h3>
                    <p class="text-sm text-muted-foreground">
                        Revoke this bucket's keys and remove it from
                        the project.
                    </p>
                </div>
                <Button
                    variant="destructive"
                    disabled={!bucketQuery.data || busy}
                    onclick={() => {
                        removeState.reset();
                        deleteOpen = true;
                    }}
                >
                    Delete bucket
                </Button>
            </CardPanel>
        </Card>
    </div>
</section>

<ConfirmDialog
    bind:open={deleteOpen}
    title={`Delete ${name}?`}
    description="Stoat revokes this bucket's keys and deletes the bucket if it is empty. A bucket that still holds objects is kept at the provider."
    confirmLabel="Delete bucket"
    pending={removeState.isPending}
    error={removeState.error?.message ?? ""}
    onconfirm={() => removeState.mutate(input)}
/>
