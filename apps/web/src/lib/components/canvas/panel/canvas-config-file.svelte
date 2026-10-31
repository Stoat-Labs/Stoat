<!-- A Git config file (`configs.*.file`): edits stage, and the next deploy commits them. -->
<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { createQuery } from "@tanstack/svelte-query";
    import type { CanvasResource } from "../graph";

    let {
        resource,
        file,
    }: {
        resource: CanvasResource;
        /** The path as Compose writes it, like `./party.conf`. */
        file: string;
    } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
        file,
    });

    const fileQuery = createQuery(() =>
        orpc.resources.readConfigFile.queryOptions({
            input,
            retry: false,
        }),
    );

    // What is typed; until then the editor shows the staged or committed content.
    let typed = $state<string>();

    let pending = $state(false);

    let error = $state("");

    const dirty = $derived(
        typed !== undefined && typed !== fileQuery.data?.content,
    );

    async function save(content: string | null) {
        pending = true;
        error = "";

        try {
            await client.resources.updateConfigFile({
                ...input,
                content,
            });

            // A revert shows the committed file again.
            if (content === null) typed = undefined;
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.readConfigFile.key({
                        input,
                    }),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
            ]);
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "The config file could not be saved.";
        } finally {
            pending = false;
        }
    }
</script>

<div class="flex h-full flex-col">
    <!-- The compose tab's strip; Save stays rendered so the strip does not shift. -->
    <div
        class="flex h-10 shrink-0 items-center gap-3 border-b pr-2 pl-6 text-xs font-medium"
    >
        <p class="min-w-0 flex-1 truncate font-mono">{file}</p>
        {#if fileQuery.data?.edited}
            <Badge variant="outline">Commits on deploy</Badge>
            <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onclick={() => void save(null)}
            >
                Revert
            </Button>
        {/if}
        <Button
            size="xs"
            disabled={!dirty || pending}
            loading={pending && dirty}
            onclick={() => void save(typed ?? "")}
        >
            Save
        </Button>
    </div>
    {#if error}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}
    {#if fileQuery.isPending}
        <Skeleton
            loading
            count={8}
            label="Loading {file}"
            class="px-3 py-4"
        >
            <div class="h-6 font-mono text-sm">config</div>
        </Skeleton>
    {:else if fileQuery.isError}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>
                {fileQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <!-- The editor reads its value once, so a revert remounts it with the committed file. -->
        {#key fileQuery.data.edited}
            <div class="min-h-0 flex-1">
                <CodeEditor
                    bind:value={
                        () => typed ?? fileQuery.data.content,
                        (value) => (typed = value)
                    }
                    language="text"
                    label="{file} content"
                    readOnly={pending}
                    fill
                />
            </div>
        {/key}
    {/if}
</div>
