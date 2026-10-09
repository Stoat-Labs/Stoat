<script lang="ts">
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import BucketDetail from "$lib/components/s3/bucket-detail.svelte";
    import BucketFiles from "$lib/components/s3/bucket-files.svelte";
    import BucketUsage from "$lib/components/s3/bucket-usage.svelte";
    import ProviderIcon from "$lib/components/s3/provider-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Spinner } from "$lib/components/ui/spinner";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { s3BucketStatusVariant } from "$lib/s3";
    import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
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
        orpc.buckets.get.queryOptions({
            input,
            // Poll while the background job runs.
            refetchInterval: (query) =>
                query.state.data?.status === "provisioning" ||
                query.state.data?.status === "deleting"
                    ? 2_000
                    : false,
            retry: false,
        }),
    );

    const bucket = $derived(bucketQuery.data);

    const busy = $derived(
        bucket?.status === "provisioning" ||
            bucket?.status === "deleting",
    );

    const statusMessages = {
        provisioning: "Creating the bucket and its access keys…",
        deleting: "Revoking keys and deleting the bucket…",
        failed: "The last operation failed",
        ready: "",
    } as const;

    const statusMessage = $derived(
        bucket ? statusMessages[bucket.status] : "",
    );

    // The deletion job removes the resource. A failed refetch keeps the last
    // data, so an error on a bucket last seen deleting means it is gone.
    const deleted = $derived(
        bucketQuery.isError && bucket?.status === "deleting",
    );

    $effect(() => {
        if (deleted)
            void queryClient
                .invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId },
                    }),
                })
                .then(() => goto(`/projects/${projectId}`));
    });

    function refresh() {
        return queryClient.invalidateQueries({
            queryKey: orpc.buckets.get.queryKey({ input }),
        });
    }

    const retryState = createMutation(() =>
        orpc.buckets.retry.mutationOptions({ onSuccess: refresh }),
    );
</script>

<div class="flex w-full flex-col gap-6 pt-6 xl:min-h-0 xl:flex-1">
    {#if bucketQuery.isError && !deleted}
        <Alert variant="error">
            <AlertDescription>
                Unable to load the bucket: {bucketQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !bucket}
        <Skeleton loading loading-label="Loading bucket">
            <div class="flex flex-col gap-6">
                <div class="flex items-start gap-3">
                    <span class="size-14 shrink-0 rounded-lg"></span>
                    <div>
                        <h1 class="text-2xl font-semibold">
                            Bucket name
                        </h1>
                        <p class="mt-1 text-sm">bucket-name</p>
                    </div>
                </div>
                <div
                    class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-3"
                >
                    <Frame class="min-w-0">
                        <FrameHeader>
                            <FrameTitle class="text-base">
                                <h2>Details</h2>
                            </FrameTitle>
                        </FrameHeader>
                        <FramePanel>
                            <dl
                                class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm"
                            >
                                {#each ["Connection", "Endpoint", "Region", "Addressing", "Access keys"] as label (label)}
                                    <dt>{label}</dt>
                                    <dd>Placeholder value</dd>
                                {/each}
                            </dl>
                        </FramePanel>
                    </Frame>
                    <Frame class="min-w-0 xl:col-span-2">
                        <FrameHeader>
                            <FrameTitle class="text-base">
                                <h2>Files</h2>
                            </FrameTitle>
                        </FrameHeader>
                        <FramePanel class="p-4 text-sm">
                            file-name.txt
                        </FramePanel>
                    </Frame>
                </div>
            </div>
        </Skeleton>
    {:else}
        <div class="flex flex-wrap items-start gap-4">
            <div class="flex min-w-0 items-start gap-3">
                <ProviderIcon
                    provider={bucket.connection.provider}
                    class="size-14"
                />
                <div class="min-w-0">
                    <div class="flex items-center gap-2">
                        <h1
                            class="text-2xl font-semibold break-anywhere"
                        >
                            {name}
                        </h1>
                        <Badge
                            variant={s3BucketStatusVariant[
                                bucket.status
                            ]}
                            class="capitalize"
                        >
                            {bucket.status}
                        </Badge>
                    </div>
                    <p
                        class="mt-1 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
                    >
                        <span class="font-mono">{bucket.name}</span>
                        {#if statusMessage}
                            <span aria-hidden="true">·</span>
                            <span
                                class="flex min-w-0 items-center gap-1.5"
                                role="status"
                            >
                                {#if busy}
                                    <Spinner
                                        class="size-3.5 shrink-0"
                                        aria-hidden="true"
                                    />
                                {:else}
                                    <TriangleAlert
                                        class="size-3.5 shrink-0 text-destructive-foreground"
                                    />
                                {/if}
                                <span class="truncate">
                                    {statusMessage}
                                </span>
                            </span>
                        {/if}
                    </p>
                </div>
            </div>
        </div>

        <div class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-3">
            <div class="flex min-h-0 min-w-0 flex-col gap-6">
                {#if bucket.status === "ready"}
                    <BucketUsage
                        usage={bucket.usage}
                        quota={bucket.quota}
                    />
                {/if}

                <Frame
                    class="min-w-0 flex-1"
                    role="region"
                    aria-labelledby="bucket-details-heading"
                >
                    <FrameHeader>
                        <FrameTitle class="text-base">
                            <h2 id="bucket-details-heading">
                                Details
                            </h2>
                        </FrameTitle>
                    </FrameHeader>
                    <FramePanel class="flex-1 p-0">
                        <a
                            class="flex min-w-0 items-center gap-2 p-3 text-sm font-medium underline-offset-4 hover:underline"
                            href={`/s3/${bucket.connection.id}`}
                        >
                            <ProviderIcon
                                provider={bucket.connection.provider}
                                class="size-5 shrink-0"
                            />
                            <span class="truncate">
                                {bucket.connection.name}
                            </span>
                            <span
                                class="shrink-0 font-normal text-muted-foreground"
                            >
                                {bucket.connection.providerName}
                            </span>
                        </a>
                        <Separator />
                        <dl class="py-1">
                            <BucketDetail
                                label="Endpoint"
                                value={bucket.connection.endpoint}
                                mono
                                copyable
                            />
                            <BucketDetail
                                label="Bucket"
                                value={bucket.name}
                                mono
                                copyable
                            />
                        </dl>
                        <Separator />
                        <dl class="py-1">
                            <BucketDetail
                                inline
                                label="Region"
                                value={bucket.connection.region}
                                mono
                            />
                            <BucketDetail
                                inline
                                label="Addressing"
                                value={bucket.connection
                                    .forcePathStyle
                                    ? "Path style"
                                    : "Virtual host"}
                            />
                            <BucketDetail
                                inline
                                label="Access keys"
                                value={bucket.scopedKey
                                    ? "Scoped to this bucket"
                                    : "Shared with the connection"}
                            />
                        </dl>
                    </FramePanel>
                </Frame>

                {#if bucket.status === "failed"}
                    <Alert variant="error">
                        <AlertDescription
                            class="flex flex-col items-start gap-3"
                        >
                            <span
                                class="font-mono text-[13px] break-anywhere"
                            >
                                {bucket.error ??
                                    "The last operation failed."}
                            </span>
                            {#if page.data.isOrganizationAdmin}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    loading={retryState.isPending}
                                    onclick={() =>
                                        retryState.mutate(input)}
                                >
                                    Retry provisioning
                                </Button>
                            {/if}
                        </AlertDescription>
                    </Alert>
                {/if}
            </div>

            {#if bucket.status === "ready"}
                <div
                    class="flex min-h-0 min-w-0 flex-col xl:col-span-2 *:data-[slot=frame]:min-h-0 *:data-[slot=frame]:flex-1"
                >
                    <BucketFiles {projectId} {resourceId} />
                </div>
            {/if}
        </div>
    {/if}
</div>
