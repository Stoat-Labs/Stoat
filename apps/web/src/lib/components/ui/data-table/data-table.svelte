<script lang="ts">
    import type { Snippet } from "svelte";
    import Inbox from "@lucide/svelte/icons/inbox";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Table,
        TableBody,
        TableCell,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import DataPagination from "./data-pagination.svelte";
    import {
        Frame,
        FrameFooter,
        FrameHeader,
        FrameTitle,
    } from "$lib/components/ui/frame";

    interface Props {
        title: string;
        /** Muted count text rendered next to the title, e.g. "1–25 of 42". */
        meta?: string;
        loading: boolean;
        loadingRows?: number;
        /** Column count, used for the full-width loading/empty cells. */
        colSpan: number;
        emptyTitle: string;
        emptyDescription: string;
        /** When true (and not loading), the empty state replaces the data rows. */
        isEmpty: boolean;
        /** 1-based current page. Bindable: passed through to DataPagination. */
        page: number;
        totalPages: number;
        /** thead content (TableRow of TableHead cells). */
        header: Snippet;
        /** tbody data rows (TableRow elements). */
        children: Snippet;
        /** Optional CTA rendered under the empty-state text. */
        emptyAction?: Snippet;
        /**
         * A data row filled with stand-in values. While loading it is
         * repeated `loadingRows` times under Phantom UI, so the skeleton
         * has the exact shape and height of the real rows.
         */
        placeholderRow?: Snippet;
    }

    let {
        title,
        meta,
        loading,
        loadingRows = 5,
        colSpan,
        emptyTitle,
        emptyDescription,
        isEmpty,
        page = $bindable<number>(),
        totalPages,
        header,
        children,
        emptyAction,
        placeholderRow,
    }: Props = $props();

    const skeletonRows = $derived(
        Array.from({ length: loadingRows }, (_, i) => i),
    );

    const showEmpty = $derived(!loading && isEmpty);
</script>

<Frame class="w-full">
    <FrameHeader
        class="flex-row items-center justify-between gap-2 px-2.5 py-3"
    >
        <FrameTitle class="min-w-0 truncate">
            <h2>{title}</h2>
        </FrameTitle>
        {#if meta}
            <span class="shrink-0 text-sm text-muted-foreground">
                {meta}
            </span>
        {/if}
    </FrameHeader>
    <Skeleton
        loading={loading && placeholderRow !== undefined}
        loading-label={`Loading ${title.toLowerCase()}`}
    >
        <Table variant="card">
            <TableHeader data-shimmer-ignore>
                {@render header()}
            </TableHeader>
            <TableBody>
                {#if loading && placeholderRow}
                    {#each skeletonRows as row (row)}
                        {@render placeholderRow()}
                    {/each}
                {:else if loading}
                    {#each skeletonRows as row (row)}
                        <TableRow
                            class="h-[72px] hover:bg-transparent"
                        >
                            <TableCell colspan={colSpan}>
                                {#if row === 0}
                                    <span
                                        class="sr-only"
                                        role="status"
                                    >
                                        Loading…
                                    </span>
                                {/if}
                                <Skeleton
                                    loading
                                    loading-label="Loading table row"
                                >
                                    <div
                                        class="grid min-h-12 grid-cols-3 items-center gap-4 px-3"
                                    >
                                        <span
                                            class="text-sm font-medium"
                                        >
                                            Table row
                                        </span>
                                        <span
                                            class="text-sm text-muted-foreground"
                                        >
                                            Row details
                                        </span>
                                        <span
                                            class="text-right text-sm text-muted-foreground"
                                        >
                                            Status
                                        </span>
                                    </div>
                                </Skeleton>
                            </TableCell>
                        </TableRow>
                    {/each}
                {:else if showEmpty}
                    <TableRow class="hover:bg-transparent">
                        <TableCell colspan={colSpan}>
                            <Empty class="gap-2 px-0 py-6 md:py-6">
                                <EmptyHeader class="max-w-none gap-2">
                                    <EmptyMedia
                                        class="mb-0 [&>div]:size-12 [&>div]:rounded-full [&>div]:bg-muted/50"
                                    >
                                        <Inbox
                                            aria-hidden="true"
                                            class="size-6 text-muted-foreground"
                                        />
                                    </EmptyMedia>
                                    <EmptyTitle class="text-base">
                                        {emptyTitle}
                                    </EmptyTitle>
                                    <EmptyDescription
                                        class="[[data-slot=empty-title]+&]:mt-0"
                                    >
                                        {emptyDescription}
                                    </EmptyDescription>
                                </EmptyHeader>
                                {#if emptyAction}
                                    <EmptyContent class="mt-2">
                                        {@render emptyAction()}
                                    </EmptyContent>
                                {/if}
                            </Empty>
                        </TableCell>
                    </TableRow>
                {:else}
                    {@render children()}
                {/if}
            </TableBody>
        </Table>
    </Skeleton>
    {#if totalPages > 1}
        <FrameFooter class="p-2">
            <DataPagination bind:page {totalPages} />
        </FrameFooter>
    {/if}
</Frame>
