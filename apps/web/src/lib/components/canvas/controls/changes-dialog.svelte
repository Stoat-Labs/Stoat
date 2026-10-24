<!-- Railway's "N changes to apply": per resource, what is live next to what the next deploy ships. -->
<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
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
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import { createQueries } from "@tanstack/svelte-query";
    import type { CanvasResource } from "../graph";
    import { lineDiff, type DiffLine } from "./line-diff";

    let {
        open = $bindable(false),
        projectId,
        changes,
        canDeploy,
        deploying,
        ondeploy,
        ondiscard,
    }: {
        open?: boolean;
        projectId: string;
        changes: {
            resource: CanvasResource;
            removed: string[];
            pendingDelete: boolean;
        }[];
        canDeploy: boolean;
        deploying: boolean;
        ondeploy: () => void;
        ondiscard: () => void;
    } = $props();

    // Fetched only while open: each one carries the resource's variables.
    const queries = createQueries(() => ({
        queries: changes.map(({ resource, pendingDelete }) =>
            orpc.resources.getPendingChanges.queryOptions({
                input: { projectId, resourceId: resource.id },
                // A deleted resource ships nothing, so it has no diff.
                enabled: open && !pendingDelete,
            }),
        ),
    }));
</script>

{#snippet diffBlock(title: string, diff: DiffLine[], secret = false)}
    <div class="overflow-hidden rounded-lg border">
        <p
            class="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground"
        >
            {title}
        </p>
        <pre
            class="overflow-x-auto py-1 font-mono text-xs leading-5"><code>{#each diff as line, index (index)}{#if line.kind === "skip"}<span
                            class="block px-3 text-muted-foreground/70 select-none">⋯ {line.count} unchanged {line.count ===
                            1
                                ? "line"
                                : "lines"}</span>{:else}<span
                            class={[
                                "block px-3",
                                line.kind === "add" &&
                                    "bg-success/10 text-success-foreground",
                                line.kind === "remove" &&
                                    "bg-destructive/10 text-destructive-foreground",
                                line.kind === "same" &&
                                    "text-muted-foreground",
                            ]}><span
                                class="select-none">{line.kind ===
                                "add"
                                    ? "+ "
                                    : line.kind === "remove"
                                      ? "- "
                                      : "  "}</span>{#if secret && line.text.includes("=")}{@const separator =
                                    line.text.indexOf("=") +
                                    1}{line.text.slice(
                                    0,
                                    separator,
                                )}<span
                                    class="blur-[5px] transition hover:blur-none">{line.text.slice(
                                        separator,
                                    )}</span>{:else}{line.text}{/if}</span>{/if}{/each}</code></pre>
    </div>
{/snippet}

<Dialog bind:open>
    <DialogContent class="sm:max-w-3xl">
        <DialogHeader>
            <DialogTitle>
                {changes.length}
                {changes.length === 1 ? "change" : "changes"} to apply
            </DialogTitle>
            <DialogDescription>
                What each resource runs now next to what the next
                deploy ships.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel class="space-y-6">
            {#each changes as { resource, removed, pendingDelete }, index (resource.id)}
                {@const query = queries[index]}
                <section class="space-y-3">
                    <div class="flex flex-wrap items-center gap-2">
                        <h3 class="text-sm font-semibold">
                            {resource.name}
                        </h3>
                        {#if pendingDelete}
                            <Badge variant="error">
                                Will be deleted
                            </Badge>
                        {:else if query?.data?.firstDeploy}
                            <Badge variant="success">
                                Will be added
                            </Badge>
                        {:else}
                            <Badge variant="info">
                                Will be updated
                            </Badge>
                        {/if}
                    </div>

                    {#if pendingDelete}
                        <p
                            class="text-sm text-destructive-foreground"
                        >
                            {resource.type === "bucket"
                                ? "Revokes its keys and deletes the bucket if it is empty."
                                : "Removes its services from the cluster and its deployment history. Volumes stay on the machines."}
                        </p>
                    {:else if query?.isError}
                        <Alert variant="error">
                            <AlertDescription>
                                Unable to load the changes: {query
                                    .error.message}
                            </AlertDescription>
                        </Alert>
                    {:else if !query?.data}
                        <Skeleton
                            loading
                            loading-label="Loading changes"
                        >
                            <div class="h-28 rounded-lg border"></div>
                        </Skeleton>
                    {:else}
                        {@const data = query.data}
                        {@const compose = lineDiff(
                            data.compose.live,
                            data.compose.next,
                        )}
                        {@const env = lineDiff(
                            data.env.live,
                            data.env.next,
                        )}
                        {#if compose.some((line) => line.kind === "add" || line.kind === "remove")}
                            {@render diffBlock("Compose", compose)}
                        {/if}
                        {#if env.some((line) => line.kind === "add" || line.kind === "remove")}
                            {@render diffBlock(
                                "Variables",
                                env,
                                true,
                            )}
                        {/if}
                        {#each data.configFiles as { file, live, next } (file)}
                            {@render diffBlock(
                                file,
                                lineDiff(live, next),
                            )}
                        {/each}
                        {#if data.prefix.live !== null && data.prefix.live !== data.prefix.next}
                            <p class="text-sm text-muted-foreground">
                                Name prefix changes from
                                <code class="font-mono">
                                    {data.prefix.live || "none"}
                                </code>
                                to
                                <code class="font-mono">
                                    {data.prefix.next || "none"}
                                </code>
                                , so every service is recreated under its
                                new name and volumes start empty.
                            </p>
                        {/if}
                        {#if removed.length}
                            <p
                                class="text-sm text-destructive-foreground"
                            >
                                Stops and removes {removed.join(
                                    ", ",
                                )}. Their volumes stay on the
                                machines.
                            </p>
                        {/if}
                    {/if}
                </section>
            {/each}
        </DialogPanel>
        <DialogFooter>
            {#if canDeploy}
                <Button
                    class="sm:me-auto"
                    variant="destructive-outline"
                    disabled={deploying}
                    onclick={ondiscard}
                >
                    Discard changes
                </Button>
            {/if}
            <Button variant="outline" onclick={() => (open = false)}>
                Close
            </Button>
            {#if canDeploy}
                <Button
                    loading={deploying}
                    disabled={deploying}
                    onclick={ondeploy}
                >
                    Deploy changes
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>
