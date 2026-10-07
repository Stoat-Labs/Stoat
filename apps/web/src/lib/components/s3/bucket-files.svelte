<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { formatDate } from "$lib/format";
    import { client, orpc } from "$lib/orpc";
    import { bytes } from "$lib/observability";
    import CornerLeftUp from "@lucide/svelte/icons/corner-left-up";
    import Download from "@lucide/svelte/icons/download";
    import File from "@lucide/svelte/icons/file";
    import Folder from "@lucide/svelte/icons/folder";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";

    let {
        projectId,
        resourceId,
    }: { projectId: string; resourceId: string } = $props();

    const location = useQueryStates(
        {
            prefix: parseAsString.withDefault(""),
        },
        { history: "push", shallow: true, scroll: false },
    );

    const filesQuery = createQuery(() =>
        orpc.buckets.listFiles.queryOptions({
            input: {
                projectId,
                resourceId,
                prefix: location.prefix.current || undefined,
            },
            retry: false,
        }),
    );

    const data = $derived(filesQuery.data);
    // S3 may return the folder's own marker object; it isn't a file.
    const files = $derived(
        data?.items.filter(
            (item) => item.key !== location.prefix.current,
        ) ?? [],
    );

    let downloadError = $state("");

    async function download(key: string) {
        downloadError = "";

        try {
            const { url } = await client.buckets.downloadUrl({
                projectId,
                resourceId,
                key,
            });

            window.location.href = url;
        } catch (cause) {
            downloadError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to download the file.";
        }
    }

    function open(prefix: string) {
        void location.set({ prefix });
    }

    function up() {
        const current = location.prefix.current.replace(/\/$/, "");

        open(
            current.includes("/")
                ? current.slice(0, current.lastIndexOf("/") + 1)
                : "",
        );
    }
</script>

<Frame role="region" aria-labelledby="bucket-files-heading">
    <FrameHeader>
        <div
            class="flex flex-wrap items-center justify-between gap-3"
        >
            <div class="min-w-0">
                <FrameTitle class="text-base">
                    <h2 id="bucket-files-heading">Files</h2>
                </FrameTitle>
                <p
                    class="mt-1 truncate font-mono text-xs text-muted-foreground"
                >
                    /{location.prefix.current}
                </p>
            </div>
        </div>
    </FrameHeader>
    <FramePanel
        class="min-h-0 flex-1 divide-y divide-border overflow-y-auto p-0"
    >
        {#if downloadError}
            <p
                class="p-3 text-sm text-destructive-foreground"
                role="alert"
            >
                {downloadError}
            </p>
        {/if}
        {#if location.prefix.current}
            <button
                type="button"
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                onclick={up}
            >
                <CornerLeftUp
                    class="size-4 text-muted-foreground"
                    aria-hidden="true"
                />
                ../
            </button>
        {/if}
        {#if filesQuery.isPending}
            <Skeleton loading loading-label="Loading files">
                {#each { length: 3 }, index (index)}
                    <div class="px-3 py-2 text-sm">file-name.txt</div>
                {/each}
            </Skeleton>
        {:else if filesQuery.isError}
            <p class="p-3 text-sm text-destructive-foreground">
                {filesQuery.error.message}
            </p>
        {:else if !data || (!data.prefixes.length && !files.length)}
            <p class="p-3 text-sm text-muted-foreground">
                This folder is empty.
            </p>
        {:else}
            {#each data.prefixes as folder (folder)}
                <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                    onclick={() => open(folder)}
                >
                    <Folder
                        class="size-4 text-muted-foreground"
                        aria-hidden="true"
                    />
                    {folder.slice(location.prefix.current.length)}
                </button>
            {/each}
            {#each files as item (item.key)}
                <div class="flex items-center gap-3 py-1 pr-1 pl-3">
                    <File
                        class="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1 truncate text-sm">
                        {item.key.slice(
                            location.prefix.current.length,
                        )}
                    </span>
                    <span
                        class="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                        {bytes(item.size)}{item.lastModified
                            ? ` · ${formatDate(new Date(item.lastModified))}`
                            : ""}
                    </span>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Download ${item.key}`}
                        onclick={() => download(item.key)}
                    >
                        <Download class="size-4" aria-hidden="true" />
                    </Button>
                </div>
            {/each}
        {/if}
    </FramePanel>
</Frame>
