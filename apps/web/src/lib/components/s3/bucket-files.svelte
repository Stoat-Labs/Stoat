<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { formatDate } from "$lib/format";
    import { client, orpc } from "$lib/api/orpc";
    import { bytes } from "$lib/observability";
    import Download from "@lucide/svelte/icons/download";
    import {
        FileTree,
        createFileTree,
        useFileTreeSelector,
        type FileTreeDirectoryHandle,
    } from "@stoat/trees";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { onMount } from "svelte";
    import { SvelteMap, SvelteSet } from "svelte/reactivity";

    let {
        projectId,
        resourceId,
    }: { projectId: string; resourceId: string } = $props();

    const file = useQueryState(
        "file",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // Listed files, for the details pane.
    const objects = new SvelteMap<
        string,
        { size: number; lastModified: Date | null }
    >();

    // Folders shown in the tree whose contents haven't been listed yet.
    const unloaded = new Set<string>();

    // Folders being listed right now; their rows show a spinner.
    const loading = new SvelteSet<string>();

    // Bumped on bucket switch so a slow listing for the old bucket is dropped.
    let generation = 0;

    let status = $state<"loading" | "ready" | "error">("loading");

    let error = $state("");

    const model = createFileTree({
        paths: [],
        icons: { set: "complete", colored: true },
        unsafeCSS:
            "@keyframes bucket-spin { to { transform: rotate(360deg); } }",
        onSelectionChange: (paths) => {
            const path = paths.at(-1);

            // Folder paths end in "/"; selecting one only expands it.
            if (path && !path.endsWith("/")) void file.set(path);
        },
    });

    // The tree has no per-row icon API, so a loading folder's chevron is swapped for a spinner in CSS.
    $effect(() => {
        const root = model.getFileTreeContainer()?.shadowRoot;

        if (!root || !loading.size) return;

        const icons = [...loading].map(
            (path) =>
                `button[data-item-path="${CSS.escape(path)}"] > [data-item-section="icon"]`,
        );

        const style = document.createElement("style");
        style.textContent = `
            :is(${icons.join(",")}) > svg { display: none; }
            :is(${icons.join(",")})::after {
                content: "";
                width: 12px;
                height: 12px;
                border: 1.5px solid currentColor;
                border-right-color: transparent;
                border-radius: 50%;
                animation: bucket-spin 0.7s linear infinite;
            }
        `;
        root.append(style);

        return () => style.remove();
    });

    const isEmpty = useFileTreeSelector(
        model,
        (m) => m.getVisibleCount() === 0,
    );

    const selected = $derived(
        file.current ? objects.get(file.current) : undefined,
    );

    const isImage = $derived(
        /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(
            file.current ?? "",
        ),
    );

    // Presigned URLs expire after 60s, so refresh them before that.
    const previewQuery = createQuery(() => ({
        ...orpc.buckets.downloadUrl.queryOptions({
            input: { projectId, resourceId, key: file.current ?? "" },
        }),
        enabled: isImage,
        staleTime: 45_000,
        retry: false,
    }));

    async function load(prefix: string) {
        const current = generation;
        unloaded.delete(prefix);
        loading.add(prefix);

        const items = [];
        const prefixes = [];

        try {
            // S3 returns at most 100 entries per page, so follow the cursor to the end.
            let cursor: string | undefined;

            do {
                const page = await client.buckets.listFiles({
                    projectId,
                    resourceId,
                    prefix,
                    cursor,
                });

                if (current !== generation) return;

                items.push(...page.items);
                prefixes.push(...page.prefixes);
                cursor = page.cursor ?? undefined;
            } while (cursor);
        } finally {
            loading.delete(prefix);
        }

        for (const item of items) objects.set(item.key, item);

        for (const folder of prefixes) unloaded.add(folder);

        model.batch([
            ...prefixes.map((path) => ({
                type: "add" as const,
                path,
            })),
            // S3 may return the folder's own marker object; it isn't a file.
            ...items.flatMap((item) =>
                item.key === prefix
                    ? []
                    : [{ type: "add" as const, path: item.key }],
            ),
        ]);
    }

    async function expand(folder: string) {
        const current = generation;

        try {
            await load(folder);
        } catch (cause) {
            if (current !== generation) return;

            unloaded.add(folder);
            folderItem(folder)?.collapse();
            error = message(cause);
        }
    }

    // `isDirectory()` returns a literal type, which TS doesn't narrow on.
    function folderItem(path: string) {
        const item = model.getItem(path);

        // SAFETY: isDirectory() is true only on directory handles.
        return item?.isDirectory()
            ? (item as FileTreeDirectoryHandle)
            : null;
    }

    function message(cause: unknown) {
        return cause instanceof Error
            ? cause.message
            : "S3 request failed.";
    }

    onMount(() =>
        model.subscribe(() => {
            for (const folder of unloaded) {
                if (folderItem(folder)?.isExpanded())
                    void expand(folder);
            }
        }),
    );

    // `load` reads projectId and resourceId, so switching buckets re-lists from the root.
    $effect(() => {
        const current = ++generation;
        objects.clear();
        unloaded.clear();
        loading.clear();
        model.resetPaths([]);
        status = "loading";
        error = "";

        load("").then(
            () => {
                if (current === generation) status = "ready";
            },
            (cause) => {
                if (current !== generation) return;

                error = message(cause);
                status = "error";
            },
        );
    });

    async function download(key: string) {
        error = "";

        try {
            const { url } = await client.buckets.downloadUrl({
                projectId,
                resourceId,
                key,
            });

            window.location.href = url;
        } catch (cause) {
            error = message(cause);
        }
    }
</script>

<div
    class="flex h-full min-h-0 bg-card"
    role="region"
    aria-label="Files"
>
    <div class="flex w-80 shrink-0 flex-col border-r">
        {#if status === "loading"}
            <Skeleton loading label="Loading files">
                {#each { length: 8 }, index (index)}
                    <div class="px-3 py-1.5 text-sm">
                        file-name.txt
                    </div>
                {/each}
            </Skeleton>
        {:else if status === "error"}
            <p class="p-3 text-sm text-destructive-foreground">
                {error}
            </p>
        {:else if isEmpty.current}
            <p class="p-3 text-sm text-muted-foreground">
                This bucket is empty.
            </p>
        {/if}
        <FileTree
            {model}
            class="min-h-0 flex-1 {status === 'ready'
                ? ''
                : 'hidden'}"
            style="--trees-bg-override:var(--card);--trees-fg-override:var(--foreground);--trees-fg-muted-override:var(--muted-foreground);--trees-bg-muted-override:var(--accent);--trees-selected-bg-override:var(--accent);--trees-border-color-override:var(--border);--trees-accent-override:var(--primary);--trees-focus-ring-color-override:var(--primary);--trees-font-family-override:inherit;"
        />
    </div>
    <div class="flex min-w-0 flex-1 flex-col">
        {#if error && status !== "error"}
            <p
                class="border-b p-3 text-sm text-destructive-foreground"
                role="alert"
            >
                {error}
            </p>
        {/if}
        {#if file.current}
            <div class="flex items-center gap-3 border-b px-4 py-2">
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">
                        <span class="text-muted-foreground">
                            {file.current.slice(
                                0,
                                file.current.lastIndexOf("/") + 1,
                            )}
                        </span>
                        {file.current.slice(
                            file.current.lastIndexOf("/") + 1,
                        )}
                    </p>
                    {#if selected}
                        <p class="text-xs text-muted-foreground">
                            {bytes(
                                selected.size,
                            )}{selected.lastModified
                                ? ` · Modified ${formatDate(selected.lastModified)}`
                                : ""}
                        </p>
                    {/if}
                </div>
                <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Download ${file.current}`}
                    onclick={() =>
                        file.current && download(file.current)}
                >
                    <Download aria-hidden="true" />
                    Download
                </Button>
            </div>
            <div
                class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
            >
                {#if !isImage}
                    <p class="text-sm text-muted-foreground">
                        No preview for this file.
                    </p>
                {:else if previewQuery.data}
                    <img
                        src={previewQuery.data.url}
                        alt={file.current}
                        class="max-h-full max-w-full object-contain"
                    />
                {:else if previewQuery.isError}
                    <p class="text-sm text-destructive-foreground">
                        {previewQuery.error.message}
                    </p>
                {:else}
                    <Skeleton loading label="Loading preview">
                        <div class="size-48"></div>
                    </Skeleton>
                {/if}
            </div>
        {:else}
            <div class="flex flex-1 items-center justify-center">
                <p class="text-sm text-muted-foreground">
                    Select a file to preview it.
                </p>
            </div>
        {/if}
    </div>
</div>
