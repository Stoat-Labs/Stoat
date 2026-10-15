<script lang="ts" generics="T extends LogRow">
    import { Button } from "$lib/components/ui/button";
    import {
        highlightParts,
        type LogLevel,
        type LogRow,
    } from "$lib/resources/logs";
    import ArrowDown from "@lucide/svelte/icons/arrow-down";
    import ArrowUp from "@lucide/svelte/icons/arrow-up";
    import WrapText from "@lucide/svelte/icons/wrap-text";
    import { createVirtualizer } from "@tanstack/svelte-virtual";
    import { tick, untrack, type Snippet } from "svelte";

    let {
        logs,
        label = "Log output",
        timeWidth,
        formatTime,
        highlight = "",
        source,
        empty,
        children,
        wrap = $bindable(false),
        following = $bindable(true),
        viewport = $bindable(),
    }: {
        logs: T[];
        label?: string;
        /** Width of the time column in `ch`, e.g. "19ch". */
        timeWidth: string;
        formatTime: (value: string) => string;
        highlight?: string;
        /** Adds a source column, e.g. the service a line came from. */
        source?: (log: T) => string;
        empty?: Snippet;
        /** Notices rendered between the column header and the rows. */
        children?: Snippet;
        wrap?: boolean;
        /** Stick to the newest line while the viewport stays at the bottom. */
        following?: boolean;
        viewport?: HTMLDivElement;
    } = $props();

    // A coloured bar per level, as in Railway's log table.
    const levelBars: Record<LogLevel, string> = {
        error: "bg-destructive",
        warning: "bg-warning",
        success: "bg-success",
        other: "bg-info",
    };

    let atTop = $state(true);

    const virtualizer = createVirtualizer<
        HTMLDivElement,
        HTMLDivElement
    >({
        count: 0,
        getScrollElement: () => viewport ?? null,
        estimateSize: () => 26,
        overscan: 20,
    });

    const measure = (node: HTMLDivElement) =>
        $virtualizer.measureElement(node);

    $effect(() => {
        const rows = logs;
        void viewport;
        untrack(() =>
            $virtualizer.setOptions({
                count: rows.length,
                getItemKey: (index) => rows[index]!.id,
            }),
        );
    });

    $effect(() => {
        const count = logs.length;

        if (!count || !viewport || !following) return;
        void tick().then(() =>
            $virtualizer.scrollToIndex(count - 1, { align: "end" }),
        );
    });

    function onScroll() {
        if (!viewport) return;

        const atBottom =
            viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <
            40;

        if (following !== atBottom) following = atBottom;
        atTop = viewport.scrollTop < 1;
    }

    function jumpToTop() {
        following = false;
        viewport?.scrollTo({ top: 0 });
    }

    function jumpToLatest() {
        following = true;

        if (logs.length)
            $virtualizer.scrollToIndex(logs.length - 1, {
                align: "end",
            });
    }
</script>

<!-- Only the rows scroll: the column header stays put and the jump buttons float over the rows. -->
<div
    class="relative flex min-h-0 min-w-0 flex-1 flex-col"
    class:has-source={!!source}
    style:--log-time={timeWidth}
>
    <div
        class="flex shrink-0 items-center border-b py-2 pr-2 text-xs font-medium"
    >
        <p class="table-columns min-w-0 flex-1 pl-6">
            <span>Time</span>
            {#if source}<span class="hidden md:inline">
                    Source
                </span>{/if}
            <span>Data</span>
        </p>
        <Button
            variant={wrap ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label="Wrap log lines"
            title="Wrap lines"
            aria-pressed={wrap}
            onclick={() => (wrap = !wrap)}
        >
            <WrapText class="size-3.5" aria-hidden="true" />
        </Button>
    </div>

    {@render children?.()}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must support keyboard scrolling.) -->
    <div
        bind:this={viewport}
        class="min-h-0 min-w-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        tabindex="0"
        role="region"
        aria-label={label}
        onscroll={onScroll}
    >
        {#if !logs.length}
            {@render empty?.()}
        {:else}
            <div
                class="relative w-full"
                style:height={`${$virtualizer.getTotalSize()}px`}
            >
                {#each $virtualizer.getVirtualItems() as row (row.key)}
                    {@const log = logs[row.index]}
                    {#if log}
                        <div
                            class="absolute inset-x-0 top-0"
                            style:transform={`translateY(${row.start}px)`}
                            data-index={row.index}
                            use:measure
                        >
                            <div
                                class="table-columns relative py-1 pr-3 pl-6 font-mono text-xs leading-[18px] hover:bg-muted/50"
                                class:nowrap={!wrap}
                                class:text-muted-foreground={log.muted}
                            >
                                <span
                                    class="absolute inset-y-0 left-3 w-0.5 {levelBars[
                                        log.level
                                    ]}"
                                    aria-label={log.level === "other"
                                        ? "info"
                                        : log.level}
                                ></span>
                                <time
                                    datetime={log.timestamp}
                                    class="whitespace-nowrap text-muted-foreground tabular-nums"
                                    title={log.timestamp}
                                >
                                    {formatTime(log.timestamp)}
                                </time>
                                {#if source}<span
                                        class="hidden min-w-0 truncate text-muted-foreground md:inline"
                                        title={source(log)}
                                    >
                                        {source(log)}
                                    </span>{/if}
                                <span
                                    class="log-message min-w-0 whitespace-pre-wrap wrap-anywhere"
                                >
                                    {#each highlightParts(log.message, highlight) as part, index (index)}{#if index % 2}<mark
                                                class="rounded-xs bg-warning/40 text-inherit"
                                            >
                                                {part}
                                            </mark>{:else}{part}{/if}{/each}
                                </span>
                            </div>
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    </div>

    {#if logs.length}
        <div class="absolute right-4 bottom-4 flex flex-col gap-2">
            <Button
                variant="outline"
                size="icon"
                aria-label="Scroll to oldest"
                disabled={atTop}
                onclick={jumpToTop}
            >
                <ArrowUp class="size-4" aria-hidden="true" />
            </Button>
            <Button
                variant="outline"
                size="icon"
                aria-label="Scroll to latest"
                disabled={following}
                onclick={jumpToLatest}
            >
                <ArrowDown class="size-4" aria-hidden="true" />
            </Button>
        </div>
    {/if}
</div>

<style>
    /* Columns are sized in the rows' mono `ch`, so the header labels line up with them. */
    .table-columns {
        display: grid;
        grid-template-columns: var(--log-time) minmax(0, 1fr);
        column-gap: 1rem;
    }
    .nowrap .log-message {
        max-height: 18px;
        white-space: pre;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    @media (min-width: 768px) {
        .has-source .table-columns {
            grid-template-columns: var(--log-time) 22ch minmax(
                    0,
                    1fr
                );
        }
    }
</style>
