<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import type { CanvasResource } from "../graph";

    let { resource }: { resource: CanvasResource } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({ input }),
    );

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: resource.projectId },
        }),
    );

    // Until the project loads, nothing is editable, so an internal resource never flashes its edit controls.
    const readOnly = $derived(
        !projectQuery.isSuccess ||
            projectQuery.data.isInternal === true,
    );

    const details = $derived(resourceQuery.data);

    const formatted = useQueryState(
        "formatted",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );

    // Rendered from the saved draft, so unsaved edits are not in it.
    const formattedQuery = createQuery(() =>
        orpc.resources.getFormattedCompose.queryOptions({
            input,
            enabled: formatted.current,
            staleTime: 0,
            retry: false,
        }),
    );

    // Follows the saved draft until edited; saving resets it.
    let compose = $derived(details?.draftSpec ?? "");

    let saving = $state(false);

    let error = $state("");

    async function save() {
        if (!details) return;

        saving = true;
        error = "";

        try {
            const updated = await client.resources.updateComposeSpec({
                ...input,
                spec: compose,
                expectedSpec: details.draftSpec,
                expectedSource:
                    details.gitConnectionId && details.gitSource
                        ? {
                              connectionId: details.gitConnectionId,
                              ...details.gitSource,
                          }
                        : null,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        } finally {
            saving = false;
        }
    }
</script>

{#snippet loading(label: string)}
    <Skeleton loading count={8} {label} class="px-3 py-4">
        <div class="h-6 font-mono text-sm">services:</div>
    </Skeleton>
{/snippet}

<div class="flex h-full flex-col">
    <!-- The log table's column header; fixed height, so it does not jump when Save hides. -->
    <div
        class="flex h-10 shrink-0 items-center gap-3 border-b pr-2 pl-6 text-xs font-medium"
    >
        <p class="min-w-0 flex-1 truncate">
            {details?.gitSource?.path ?? "compose.yaml"}
        </p>
        <label class="flex cursor-pointer items-center gap-2">
            <Checkbox
                checked={formatted.current}
                onCheckedChange={(next) => void formatted.set(next)}
            />
            Formatted
        </label>
        <!-- Disabled rather than hidden in formatted view, so the header does not shift. -->
        {#if !readOnly}
            <Button
                size="xs"
                loading={saving}
                disabled={saving ||
                    formatted.current ||
                    compose === details?.draftSpec}
                onclick={save}
            >
                Save draft
            </Button>
        {/if}
    </div>

    {#if error}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}

    {#if resourceQuery.isPending}
        {@render loading("Loading Compose file")}
    {:else if resourceQuery.isError}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>
                Unable to load the Compose file: {resourceQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if !formatted.current}
        <div class="compose min-h-0 flex-1">
            <CodeEditor
                bind:value={compose}
                readOnly={readOnly || saving}
            />
        </div>
    {:else if formattedQuery.isPending}
        {@render loading("Loading formatted Compose")}
    {:else if formattedQuery.isError}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>
                Unable to format the Compose file: {formattedQuery
                    .error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <div class="compose min-h-0 flex-1">
            <CodeEditor value={formattedQuery.data.yaml} readOnly />
        </div>
    {/if}
</div>

<style>
    /* Fill the panel instead of the editor's default 22-32rem box. */
    .compose > :global(div),
    .compose :global(.cm-editor) {
        height: 100%;
    }

    .compose :global(.cm-scroller) {
        min-height: 0;
        max-height: none;
    }
</style>
