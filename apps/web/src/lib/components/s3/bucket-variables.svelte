<script lang="ts">
    import { page } from "$app/state";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import Eye from "@lucide/svelte/icons/eye";
    import EyeOff from "@lucide/svelte/icons/eye-off";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";

    let {
        projectId,
        resourceId,
    }: { projectId: string; resourceId: string } = $props();

    const input = $derived({ projectId, resourceId });

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({ input, retry: false }),
    );

    const bucket = $derived(bucketQuery.data);

    // Secrets are fetched only on request and never cached.
    const credentialsState = createMutation(() =>
        orpc.buckets.credentials.mutationOptions(),
    );

    const env = $derived(
        bucket
            ? [
                  `S3_ENDPOINT=${bucket.connection.endpoint}`,
                  `S3_REGION=${bucket.connection.region}`,
                  `S3_BUCKET=${bucket.name}`,
                  `S3_FORCE_PATH_STYLE=${bucket.connection.forcePathStyle}`,
                  `S3_ACCESS_KEY_ID=${credentialsState.data?.accessKey ?? ""}`,
                  `S3_SECRET_ACCESS_KEY=${credentialsState.data?.secretKey ?? ""}`,
              ].join("\n")
            : "",
    );
</script>

{#if bucketQuery.isError}
    <Alert variant="error">
        <AlertDescription>
            Unable to load the bucket: {bucketQuery.error.message}
        </AlertDescription>
    </Alert>
{:else if !bucket}
    <Skeleton
        loading
        loading-label="Loading bucket variables"
        class="flex min-h-0 flex-1 flex-col"
    >
        <Frame class="min-h-0 min-w-0 w-full flex-1">
            <FrameHeader>
                <h2 class="text-sm font-medium">.env</h2>
            </FrameHeader>
            <FramePanel class="flex-1 bg-code p-4 font-mono text-sm">
                S3_ENDPOINT=placeholder
            </FramePanel>
        </Frame>
    </Skeleton>
{:else}
    <Frame class="min-h-0 min-w-0 w-full flex-1 overflow-hidden">
        <FrameHeader
            class="flex-row flex-wrap shrink-0 items-center justify-between gap-3 px-3 py-2"
        >
            <div class="min-w-0">
                <FrameTitle class="text-sm">
                    <h2>.env</h2>
                </FrameTitle>
                <FrameDescription class="mt-0.5">
                    Paste these into a resource's variables.
                </FrameDescription>
            </div>
            {#if credentialsState.data}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={() => credentialsState.reset()}
                >
                    <EyeOff class="size-4" aria-hidden="true" />
                    Hide values
                </Button>
            {:else if page.data.isOrganizationAdmin}
                <Button
                    variant="outline"
                    size="sm"
                    disabled={bucket.status !== "ready"}
                    loading={credentialsState.isPending}
                    onclick={() => credentialsState.mutate(input)}
                >
                    <Eye class="size-4" aria-hidden="true" />
                    Show values
                </Button>
            {/if}
        </FrameHeader>
        {#if credentialsState.isError}
            <p
                class="px-3 pb-2 text-sm text-destructive-foreground"
                role="alert"
            >
                {credentialsState.error.message}
            </p>
        {/if}
        <FramePanel
            class="env-editor-canvas flex min-h-0 min-w-0 flex-1 overflow-hidden bg-code p-0 dark:bg-black/20"
        >
            <CodeEditor
                value={env}
                language="env"
                label="Bucket environment variables"
                hideEnvValues={!credentialsState.data}
                readOnly
            />
        </FramePanel>
    </Frame>
{/if}

<style>
    :global(.env-editor-canvas > div),
    :global(.env-editor-canvas .cm-editor) {
        height: 100%;
        min-height: 0;
    }

    :global(.env-editor-canvas .cm-scroller) {
        height: 100%;
        min-height: 0;
        max-height: none;
    }
</style>
