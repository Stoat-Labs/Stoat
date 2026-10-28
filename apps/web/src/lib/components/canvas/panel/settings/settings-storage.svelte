<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import BucketLimitDialog from "$lib/components/s3/bucket-limit-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { bytes } from "$lib/observability";
    import { bucketJobPollInterval } from "$lib/s3";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import type { CanvasResource } from "../../graph";
    import SettingsTitle from "./settings-title.svelte";

    let {
        resource,
        isAdmin,
    }: { resource: CanvasResource; isAdmin: boolean } = $props();

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({
            input: {
                projectId: resource.projectId,
                resourceId: resource.id,
            },
            refetchInterval: (query) =>
                bucketJobPollInterval(query.state.data?.status),
            retry: false,
        }),
    );

    const bucket = $derived(bucketQuery.data);

    const limitDialog = useQueryState(
        "limitDialog",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );
</script>

<div>
    <SettingsTitle
        text={"Storage limit"}
        description={"Cap how much this bucket can hold."}
    />
    <div
        class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
    >
        <div class="min-w-0 flex-1">
            <p class="truncate">
                {bucket?.quota ? bytes(bucket.quota) : "No limit"}
            </p>
            {#if bucket}
                <p class="truncate text-sm text-muted-foreground">
                    {bucket.enforcedQuota
                        ? `${bucket.connection.providerName} rejects uploads past the limit.`
                        : `Display only: ${bucket.connection.providerName} cannot enforce a limit.`}
                </p>
            {/if}
        </div>
        {#if isAdmin}
            <Button
                size="sm"
                variant="outline"
                disabled={bucket?.status !== "ready"}
                onclick={() => void limitDialog.set(true)}
            >
                {bucket?.quota ? "Edit limit" : "Set limit"}
            </Button>
        {/if}
    </div>
</div>

<BucketLimitDialog
    projectId={resource.projectId}
    resourceId={resource.id}
    {bucket}
    bind:open={
        () => limitDialog.current,
        (open) => void limitDialog.set(open)
    }
/>
