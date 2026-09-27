<script lang="ts" generics="T extends LogRow">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "$lib/components/ui/empty";
    import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "$lib/components/ui/tooltip";
    import { logActivity, logBucketIndex, stripLogPrefix, type LogBucket, type LogLevel, type LogRow } from "$lib/resource-logs";
    import ArrowDown from "@lucide/svelte/icons/arrow-down";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import WrapText from "@lucide/svelte/icons/wrap-text";
    import { createVirtualizer } from "@tanstack/svelte-virtual";
    import { onMount, tick, untrack, type Snippet } from "svelte";

    let {
        logs,
        loading = false,
        pending = false,
        follow = true,
        start,
        end,
        highlight = "",
        note = "",
        label = "Log output",
        timeWidth = "12ch",
        formatTime = (value: string | number) => time(value),
        source,
        details,
        empty,
        actions,
        children,
        level = $bindable(null),
        bucket = $bindable(null),
        wrap = $bindable(false),
        clean = $bindable(true),
        following = $bindable(true),
        scroll = $bindable(0),
        entry = $bindable(null),
        viewport = $bindable(),
    }: {
        /** Loaded logs after any text filtering; level and time filters are applied here. */
        logs: T[];
        loading?: boolean;
        pending?: boolean;
        /** Stick to the newest line while the user stays at the bottom. */
        follow?: boolean;
        start?: number;
        end?: number;
        highlight?: string;
        note?: string;
        label?: string;
        timeWidth?: string;
        formatTime?: (value: string) => string;
        source?: (log: T) => string;
        details?: Snippet<[T]>;
        empty?: Snippet;
        actions?: Snippet;
        children?: Snippet;
        level?: LogLevel | null;
        bucket?: LogBucket | null;
        wrap?: boolean;
        clean?: boolean;
        following?: boolean;
        scroll?: number;
        entry?: string | null;
        viewport?: HTMLDivElement;
    } = $props();

    const series: { key: LogLevel; label: string; color: string; foreground: string }[] = [
        { key: "error", label: "Errors", color: "bg-destructive", foreground: "text-destructive-foreground" },
        { key: "warning", label: "Warnings", color: "bg-warning", foreground: "text-warning-foreground" },
        { key: "success", label: "Success", color: "bg-success", foreground: "text-success-foreground" },
        { key: "other", label: "Info", color: "bg-muted-foreground/40", foreground: "text-muted-foreground" },
    ];

    let activeBucket = $state<number | null>(null);

    let copiedId = $state<number | null>(null);

    let copyError = $state("");

    let timezone = $state("Local time");

    let restored = false;

    const chartStart = $derived(bucket?.domainStart ?? start ?? logs[0]?.time ?? 0);

    const chartEnd = $derived(bucket?.domainEnd ?? end ?? Math.max(chartStart + 1000, logs.at(-1)?.time ?? 0));

    const activity = $derived(logActivity(logs, chartStart, chartEnd));

    const selectedRange = $derived(bucket ? activity.buckets[bucket.index] : null);

    const visibleLogs = $derived(level || bucket ? logs.filter((log) =>
        (!level || log.level === level) &&
        (!bucket || logBucketIndex(log.time, bucket.domainStart, bucket.domainEnd) === bucket.index),
    ) : logs);

    onMount(() => {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    });

    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: 0,
        getScrollElement: () => viewport ?? null,
        estimateSize: () => 20,
        overscan: 20,
        paddingStart: 6,
        paddingEnd: 6,
    });

    const measure = (node: HTMLDivElement) => $virtualizer.measureElement(node);

    $effect(() => {
        const rows = visibleLogs;
        void viewport;
        untrack(() => $virtualizer.setOptions({ count: rows.length, getItemKey: (index) => rows[index]!.id }));
    });

    $effect(() => {
        const count = visibleLogs.length;
        const stick = follow && following && !bucket;

        if (!count || !viewport) return;
        // Restore the saved offset once; later scroll updates come from the user.
        const target = restored ? 0 : untrack(() => scroll);
        restored = true;

        void tick().then(() => {
            if (stick) $virtualizer.scrollToIndex(count - 1, { align: "end" });
            else if (target > 0 && viewport) viewport.scrollTop = target;
        });
    });

    $effect(() => {
        if (activeBucket !== null && !activity.buckets[activeBucket]?.total) activeBucket = null;
    });

    async function selectBucket(index: number | null) {
        if (index !== null && !activity.buckets[index]?.total) return;

        // Capture the domain rather than following a bar whose boundaries shift with live output.
        const next = index === null || bucket?.index === index ? null : { index, domainStart: chartStart, domainEnd: chartEnd };

        bucket = next;
        activeBucket = index;
        entry = null;
        following = next === null;
        scroll = 0;
        await tick();

        if (next && viewport) viewport.scrollTop = 0;
    }

    function onViewportScroll() {
        if (!viewport) return;
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;

        if (follow && !bucket && following !== atBottom) following = atBottom;
        const next = follow && !bucket && atBottom ? 0 : Math.max(0, Math.round(viewport.scrollTop));

        if (scroll !== next) scroll = next;
    }

    async function copy(log: T) {
        copyError = "";

        try { await navigator.clipboard.writeText(log.message); copiedId = log.id; }
        catch { copyError = "Unable to copy. Select the message text to copy it manually."; }
    }

    function time(value: string | number) {
        return new Date(value).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
    }

    function marked(text: string) {
        const needle = highlight.trim().toLowerCase();

        if (!needle) return [text];
        const lower = text.toLowerCase();
        const parts: string[] = [];
        let from = 0;

        for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
            parts.push(text.slice(from, at), text.slice(at, at + needle.length));
            from = at + needle.length;
        }

        parts.push(text.slice(from));

        return parts;
    }
</script>

<section class="shrink-0 border-b px-3 py-2 sm:px-4" aria-label="Log activity">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div class="flex flex-wrap gap-1" role="group" aria-label="Filter by log classification">
            {#each series as item (item.key)}
                <Button variant={level === item.key ? "secondary" : "ghost"} size="xs" class="gap-1.5 text-xs" aria-pressed={level === item.key} onclick={() => level = level === item.key ? null : item.key}>
                    <span class="size-2 rounded-xs {item.color}" aria-hidden="true"></span><span class={item.foreground}>{item.label}</span><span class="font-mono tabular-nums">{activity.counts[item.key]}</span>
                </Button>
            {/each}
        </div>
    </div>
    <TooltipProvider delay={100}>
        <div class="relative mt-2 flex h-16 gap-1 border-b border-border sm:h-20" role="group" aria-label="Log activity by time. Hover for counts; select a bar to filter logs.">
            {#each activity.buckets as item, index (index)}
                {#if loading}
                    <span class="min-w-0 flex-1 self-end rounded-t-sm" style:height={`${20 + (index * 17) % 65}%`}></span>
                {:else if item.total > 0}
                <Tooltip
                    triggerId={`log-bucket-${index}`}
                    bind:open={() => activeBucket === index, (open) => { if (open) activeBucket = index; else if (activeBucket === index) activeBucket = null; }}
                    disabled={!logs.length}
                >
                    <TooltipTrigger
                        id={`log-bucket-${index}`}
                        type="button"
                        closeOnClick={false}
                        disabled={!logs.length}
                        class="flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse justify-start rounded-t-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/60 aria-pressed:ring-1 aria-pressed:ring-foreground/70 {bucket && bucket.index !== index ? 'opacity-40' : ''}"
                        aria-label="Show logs from {time(item.start)} to {time(item.end)}: {item.total} lines, {item.error} errors, {item.warning} warnings, {item.success} successes, {item.other} info"
                        aria-pressed={bucket?.index === index}
                        aria-describedby={activeBucket === index && logs.length ? `log-bucket-tooltip-${index}` : undefined}
                        onclick={() => selectBucket(index)}
                    >
                        {#each series as serie (serie.key)}
                            <span class="w-full min-w-0 shrink-0 {serie.color}" style:height={`${item[serie.key] / activity.maximum * 100}%`}></span>
                        {/each}
                    </TooltipTrigger>
                    <TooltipPopup id={`log-bucket-tooltip-${index}`} role="tooltip" side="top" sideOffset={8} class="w-60 max-w-[calc(100vw-2rem)] text-left">
                        <div class="space-y-2 py-1.5">
                            <div class="space-y-0.5 border-b pb-2">
                                <p class="font-medium">{new Date(item.start).toLocaleDateString()} / {timezone}</p>
                                <p class="font-mono text-[11px] text-muted-foreground">{time(item.start)} - {time(item.end)}</p>
                            </div>
                            <dl class="space-y-1">
                                {#each series as serie (serie.key)}
                                    <div class="flex items-center justify-between gap-4"><dt class={serie.foreground}>{serie.label}</dt><dd class="font-mono tabular-nums">{item[serie.key].toLocaleString()}</dd></div>
                                {/each}
                                <div class="flex items-center justify-between gap-4 border-t pt-1.5 font-medium"><dt>Total</dt><dd class="font-mono tabular-nums">{item.total.toLocaleString()}</dd></div>
                            </dl>
                        </div>
                    </TooltipPopup>
                </Tooltip>
                {:else}
                    <span class="min-w-0 flex-1" aria-hidden="true"></span>
                {/if}
            {/each}
            {#if !loading && !logs.length}<span class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{pending ? "Searching..." : "No activity loaded"}</span>{/if}
        </div>
    </TooltipProvider>
    <div class="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{loading ? "00:00:00.000" : logs.length || start !== undefined ? time(chartStart) : ""}</span>
        <span title="Classification uses explicit log levels and HTTP status codes. Informational and unclassified lines are shown as INFO.">Explicit levels / HTTP status</span>
        <span>{loading ? "00:00:00.000" : logs.length || start !== undefined ? time(chartEnd) : ""}</span>
    </div>
</section>

{@render children?.()}
{#if copyError}<Alert variant="error" class="m-2 shrink-0 px-3 py-2"><AlertDescription>{copyError}</AlertDescription></Alert>{/if}

<div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
    <p class="text-xs text-muted-foreground">{visibleLogs.length.toLocaleString()} lines{#if level} / {series.find((item) => item.key === level)?.label}{/if}{#if note}<span class="ml-2">{note}</span>{/if}</p>
    {#if selectedRange}
        <p class="min-w-0 text-xs text-muted-foreground" role="status" title="{new Date(selectedRange.start).toLocaleString()} to {new Date(selectedRange.end).toLocaleString()}. The selected range stays fixed while logs arrive.">
            {time(selectedRange.start)} - {time(selectedRange.end)}
        </p>
    {/if}
    <div class="flex items-center gap-1">
        {#if bucket}<Button variant="outline" size="xs" onclick={() => selectBucket(null)}>Show all times</Button>{/if}
        {#if level}<Button variant="ghost" size="xs" onclick={() => level = null}>Clear level filter</Button>{/if}
        {#if follow && !following && !bucket}<Button variant="ghost" size="xs" onclick={() => { following = true; scroll = 0; if (visibleLogs.length) $virtualizer.scrollToIndex(visibleLogs.length - 1, { align: "end" }); }}><ArrowDown class="size-3" aria-hidden="true" />Jump to latest</Button>{/if}
        {@render actions?.()}
        <Button variant={wrap ? "secondary" : "ghost"} size="icon-xs" aria-label="Wrap log lines" title="Wrap lines" aria-pressed={wrap} onclick={() => wrap = !wrap}><WrapText class="size-3.5" aria-hidden="true" /></Button>
        <Button variant={!clean ? "secondary" : "ghost"} size="icon-xs" aria-label="Hide duplicate timestamps and levels in messages" title="Hide duplicate timestamps and levels" aria-pressed={clean} onclick={() => clean = !clean}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true"><path d="M8 19v-9a4 4 0 0 1 2.5-3.7V4a1.5 1.5 0 0 1 3 0v2.3A4 4 0 0 1 16 10v9" /><rect x="6" y="19" width="12" height="3" rx="1.5" /></svg>
        </Button>
    </div>
</div>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must support keyboard scrolling.) -->
<div bind:this={viewport} class="min-h-0 min-w-0 flex-1 overflow-auto bg-code px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-black/20 {loading || !visibleLogs.length ? 'py-1.5' : ''}" class:has-source={!!source} style:--log-time={timeWidth} tabindex="0" role="region" aria-label={label} aria-busy={pending} onscroll={onViewportScroll}>
    {#if loading}
        <div class="flex h-full min-h-0 flex-col" aria-hidden="true">
            {#each Array(16) as _, index (index)}
                <div class="log-row log-placeholder min-h-0 basis-[38px] grid-rows-2 items-center px-1.5 font-mono text-xs md:basis-5 md:grid-rows-1">
                    <span class="h-3/5 max-h-3 w-[11ch] rounded-xs"></span>
                    <span class="h-3/5 max-h-3 w-[5ch] rounded-xs"></span>
                    {#if source}<span class="h-3/5 max-h-3 w-3/4 rounded-xs"></span>{/if}
                    <span class="log-message h-3/5 max-h-3 rounded-xs" style:width={`${35 + (index * 19) % 60}%`}></span>
                </div>
            {/each}
        </div>
    {:else if !visibleLogs.length && logs.length && (level || bucket)}
        <Empty class="h-full"><EmptyHeader><EmptyTitle>{bucket ? "No matching logs in this time range" : "No lines at this level"}</EmptyTitle><EmptyDescription>Choose another bar, clear the level filter, or show all times to see more loaded logs.</EmptyDescription></EmptyHeader></Empty>
    {:else if !visibleLogs.length}
        {@render empty?.()}
    {:else}
        <div class="relative w-full" style:height={`${$virtualizer.getTotalSize()}px`}>
        {#each $virtualizer.getVirtualItems() as row (row.key)}
            {@const log = visibleLogs[row.index]}
            {#if log}
            <div class="absolute inset-x-0 top-0" style:transform={`translateY(${row.start}px)`} data-index={row.index} use:measure>
            {#snippet line()}
                <time datetime={log.timestamp} class="whitespace-nowrap text-muted-foreground tabular-nums" title={log.timestamp}>{formatTime(log.timestamp)}</time>
                <Badge size="sm" variant={log.level === "other" ? "secondary" : log.level} class="mt-px w-full h-4 justify-self-start self-start font-mono text-[10px] uppercase tracking-normal">{log.label ?? (log.level === "other" ? "INFO" : log.level)}</Badge>
                {#if source}<span class="min-w-0 truncate text-muted-foreground" title={source(log)}>{source(log)}</span>{/if}
                <span class="log-message min-w-0 whitespace-pre-wrap wrap-anywhere">{#each marked(clean ? stripLogPrefix(log.message) : log.message) as part, index (index)}{#if index % 2}<mark class="rounded-xs bg-warning/40 text-inherit">{part}</mark>{:else}{part}{/if}{/each}</span>
            {/snippet}
            {#if !details}
                <div class="log-row rounded-sm px-1.5 py-px font-mono text-xs leading-[18px] hover:bg-muted/50 pointer-coarse:min-h-6" class:nowrap={!wrap} class:text-muted-foreground={log.muted}>{@render line()}</div>
            {:else}
            <details class="group rounded-md open:bg-muted/50" name="log-entry" bind:open={() => entry === log.key, (open) => { if (open) entry = log.key; else if (entry === log.key) entry = null; }}>
                <!-- Selecting text inside a row shouldn't toggle it. -->
                <summary class="log-row cursor-pointer list-none rounded-sm px-1.5 py-px font-mono text-xs leading-[18px] outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-6" class:nowrap={!wrap} class:text-muted-foreground={log.muted} onclick={(event) => { if (getSelection()?.toString()) event.preventDefault(); }}>
                    {@render line()}
                </summary>
                {#if entry === log.key}
                <div class="space-y-2 border-t border-border px-3 py-2">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                        <dl class="grid min-w-0 gap-x-4 gap-y-1 text-xs sm:grid-cols-2 [&_dt]:mr-1">
                            <div><dt class="inline text-muted-foreground">Time </dt><dd class="inline font-mono wrap-anywhere">{log.timestamp}</dd></div>
                            {@render details?.(log)}
                        </dl>
                        <Button variant="outline" size="xs" onclick={() => copy(log)}>{#if copiedId === log.id}<Check class="size-3" aria-hidden="true" />Copied{:else}<Copy class="size-3" aria-hidden="true" />Copy{/if}</Button>
                    </div>
                    <pre class="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 wrap-anywhere">{log.message}</pre>
                </div>
                {/if}
            </details>
            {/if}
            </div>
            {/if}
        {/each}
        </div>
    {/if}
</div>

<style>
    .log-row { display: grid; grid-template-columns: var(--log-time) 7ch minmax(0, 1fr); column-gap: 0.5rem; }
    .has-source .log-message { grid-column: 1 / -1; }
    .nowrap .log-message { max-height: 18px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    summary::-webkit-details-marker { display: none; }
    @media (max-width: 767px) {
        .log-placeholder:nth-child(n + 9) { display: none; }
    }
    @media (min-width: 768px) {
        .has-source .log-row { grid-template-columns: var(--log-time) 7ch 22ch minmax(0, 1fr); }
        .has-source .log-message { grid-column: auto; }
    }
</style>
