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

<div class="flex items-center justify-between gap-4">
    <h3 class="flex items-center gap-3 text-xl text-muted-foreground">
        Content
        {#if fileQuery.data?.edited}
            <Badge variant="outline">Commits on deploy</Badge>
        {/if}
    </h3>
    <div class="flex gap-2">
        {#if fileQuery.data?.edited}
            <Button
                variant="outline"
                disabled={pending}
                onclick={() => void save(null)}
            >
                Revert
            </Button>
        {/if}
        <Button
            disabled={!dirty || pending}
            loading={pending && dirty}
            onclick={() => void save(typed ?? "")}
        >
            Save
        </Button>
    </div>
</div>
<p class="font-mono text-sm text-muted-foreground">{file}</p>
{#if error}
    <Alert variant="error">
        <AlertDescription>{error}</AlertDescription>
    </Alert>
{/if}
{#if fileQuery.isPending}
    <Skeleton
        loading
        count={6}
        loading-label="Loading {file}"
        class="rounded-lg border px-3 py-4"
    >
        <div class="h-6 font-mono text-sm">config</div>
    </Skeleton>
{:else if fileQuery.isError}
    <Alert variant="error">
        <AlertDescription>{fileQuery.error.message}</AlertDescription>
    </Alert>
{:else}
    <!-- The editor reads its value once, so a revert remounts it with the committed file. -->
    {#key fileQuery.data.edited}
        <div class="overflow-hidden rounded-lg border">
            <CodeEditor
                bind:value={
                    () => typed ?? fileQuery.data.content,
                    (value) => (typed = value)
                }
                language="text"
                label="{file} content"
                readOnly={pending}
            />
        </div>
    {/key}
{/if}
