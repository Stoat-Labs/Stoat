<script lang="ts">
    import { page } from "$app/state";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { bytes } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import BucketLimitDialog from "./bucket-limit-dialog.svelte";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryStates } from "nuqs-svelte";

    let {
        projectId,
        resourceId,
    }: { projectId: string; resourceId: string } = $props();

    const input = $derived({ projectId, resourceId });

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({ input, retry: false }),
    );

    const bucket = $derived(bucketQuery.data);

    const view = useQueryStates(
        { limitDialog: parseAsBoolean.withDefault(false) },
        { shallow: true, scroll: false },
    );
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="storage-limit-heading"
>
    <div>
        <h2
            id="storage-limit-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            Storage limit
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Cap how much this bucket can hold.
        </p>
    </div>

    <div class="md:col-span-2">
        <Card>
            <CardPanel
                class="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"
            >
                {#if bucket}
                    <div class="min-w-0 space-y-1">
                        <h3 class="text-sm font-medium">
                            {bucket.quota
                                ? bytes(bucket.quota)
                                : "No limit"}
                        </h3>
                        <p class="text-sm text-muted-foreground">
                            {bucket.enforcedQuota
                                ? `${bucket.connection.providerName} rejects uploads past the limit.`
                                : `Display only: ${bucket.connection.providerName} cannot enforce a limit.`}
                        </p>
                    </div>
                    {#if page.data.isOrganizationAdmin}
                        <Button
                            variant="outline"
                            disabled={bucket.status !== "ready"}
                            onclick={() =>
                                void view.set({ limitDialog: true })}
                        >
                            {bucket.quota
                                ? "Edit limit"
                                : "Set limit"}
                        </Button>
                    {/if}
                {:else}
                    <Skeleton
                        loading
                        loading-label="Loading storage limit"
                    >
                        <div class="space-y-1">
                            <h3 class="text-sm font-medium">
                                No limit
                            </h3>
                            <p class="text-sm">
                                RustFS rejects uploads past the limit.
                            </p>
                        </div>
                    </Skeleton>
                {/if}
            </CardPanel>
        </Card>
    </div>
</section>

<BucketLimitDialog
    {projectId}
    {resourceId}
    {bucket}
    bind:open={
        () => view.limitDialog.current,
        (open) => void view.set({ limitDialog: open })
    }
/>
