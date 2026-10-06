<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Tooltip,
        TooltipPopup,
        TooltipProvider,
        TooltipTrigger,
    } from "$lib/components/ui/tooltip";
    import { logTime } from "$lib/format";
    import {
        logSeries,
        type LogBucket,
        type LogLevel,
        type LogRow,
        type logActivity,
    } from "$lib/resource-logs";
    import { onMount } from "svelte";

    let {
        logs,
        activity,
        chartStart,
        chartEnd,
        start,
        loading = false,
        pending = false,
        level = $bindable(null),
        bucket,
        onSelect,
    }: {
        logs: LogRow[];
        activity: ReturnType<typeof logActivity>;
        chartStart: number;
        chartEnd: number;
        start?: number;
        loading?: boolean;
        pending?: boolean;
        level: LogLevel | null;
        bucket: LogBucket | null;
        onSelect: (index: number | null) => void;
    } = $props();

    let requestedBucket = $state<number | null>(null);

    const activeBucket = $derived(
        requestedBucket !== null &&
            !activity.buckets[requestedBucket]?.total
            ? null
            : requestedBucket,
    );

    let timezone = $state("Local time");

    onMount(() => {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    });
</script>

<section
    class="shrink-0 border-b px-3 py-2 sm:px-4"
    aria-label="Log activity"
>
    <div
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
    >
        <div
            class="flex flex-wrap gap-1"
            role="group"
            aria-label="Filter by log classification"
        >
            {#each logSeries as item (item.key)}
                <Button
                    variant={level === item.key
                        ? "secondary"
                        : "ghost"}
                    size="xs"
                    class="gap-1.5 text-xs"
                    aria-pressed={level === item.key}
                    onclick={() =>
                        (level =
                            level === item.key ? null : item.key)}
                >
                    <span
                        class="size-2 rounded-xs {item.color}"
                        aria-hidden="true"
                    ></span>
                    <span class={item.foreground}>{item.label}</span>
                    <span class="font-mono tabular-nums">
                        {activity.counts[item.key]}
                    </span>
                </Button>
            {/each}
        </div>
    </div>
    <TooltipProvider delay={100}>
        <div
            class="relative mt-2 flex h-16 gap-1 border-b border-border sm:h-20"
            role="group"
            aria-label="Log activity by time. Hover for counts; select a bar to filter logs."
        >
            {#each activity.buckets as item, index (index)}
                {#if loading}
                    <span
                        class="min-w-0 flex-1 self-end rounded-t-sm"
                        style:height={`${20 + ((index * 17) % 65)}%`}
                    ></span>
                {:else if item.total > 0}
                    <Tooltip
                        triggerId={`log-bucket-${index}`}
                        bind:open={
                            () => activeBucket === index,
                            (open) => {
                                if (open) requestedBucket = index;
                                else if (activeBucket === index)
                                    requestedBucket = null;
                            }
                        }
                        disabled={!logs.length}
                    >
                        <TooltipTrigger
                            id={`log-bucket-${index}`}
                            type="button"
                            closeOnClick={false}
                            disabled={!logs.length}
                            class="flex h-full min-w-0 flex-1 cursor-pointer flex-col-reverse justify-start rounded-t-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted/60 aria-pressed:ring-1 aria-pressed:ring-foreground/70 {bucket &&
                            bucket.index !== index
                                ? 'opacity-40'
                                : ''}"
                            aria-label="Show logs from {logTime(
                                item.start,
                            )} to {logTime(
                                item.end,
                            )}: {item.total} lines, {item.error} errors, {item.warning} warnings, {item.success} successes, {item.other} info"
                            aria-pressed={bucket?.index === index}
                            aria-describedby={activeBucket ===
                                index && logs.length
                                ? `log-bucket-tooltip-${index}`
                                : undefined}
                            onclick={() => onSelect(index)}
                        >
                            {#each logSeries as serie (serie.key)}
                                <span
                                    class="w-full min-w-0 shrink-0 {serie.color}"
                                    style:height={`${(item[serie.key] / activity.maximum) * 100}%`}
                                ></span>
                            {/each}
                        </TooltipTrigger>
                        <TooltipPopup
                            id={`log-bucket-tooltip-${index}`}
                            role="tooltip"
                            side="top"
                            sideOffset={8}
                            class="w-60 max-w-[calc(100vw-2rem)] text-left"
                        >
                            <div class="space-y-2 py-1.5">
                                <div
                                    class="space-y-0.5 border-b pb-2"
                                >
                                    <p class="font-medium">
                                        {new Date(
                                            item.start,
                                        ).toLocaleDateString()} / {timezone}
                                    </p>
                                    <p
                                        class="font-mono text-[11px] text-muted-foreground"
                                    >
                                        {logTime(item.start)} - {logTime(
                                            item.end,
                                        )}
                                    </p>
                                </div>
                                <dl class="space-y-1">
                                    {#each logSeries as serie (serie.key)}
                                        <div
                                            class="flex items-center justify-between gap-4"
                                        >
                                            <dt
                                                class={serie.foreground}
                                            >
                                                {serie.label}
                                            </dt>
                                            <dd
                                                class="font-mono tabular-nums"
                                            >
                                                {item[
                                                    serie.key
                                                ].toLocaleString()}
                                            </dd>
                                        </div>
                                    {/each}
                                    <div
                                        class="flex items-center justify-between gap-4 border-t pt-1.5 font-medium"
                                    >
                                        <dt>Total</dt>
                                        <dd
                                            class="font-mono tabular-nums"
                                        >
                                            {item.total.toLocaleString()}
                                        </dd>
                                    </div>
                                </dl>
                            </div>
                        </TooltipPopup>
                    </Tooltip>
                {:else}
                    <span
                        class="min-w-0 flex-1"
                        aria-hidden="true"
                    ></span>
                {/if}
            {/each}
            {#if !loading && !logs.length}<span
                    class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
                >
                    {pending ? "Searching..." : "No activity loaded"}
                </span>{/if}
        </div>
    </TooltipProvider>
    <div
        class="mt-1 flex min-w-0 justify-between gap-2 text-[11px] tabular-nums text-muted-foreground"
    >
        <span class="shrink-0">
            {loading
                ? "00:00:00.000"
                : logs.length || start !== undefined
                  ? logTime(chartStart)
                  : ""}
        </span>
        <span
            class="hidden min-w-0 truncate sm:inline"
            title="Classification uses explicit log levels and HTTP status codes. Informational and unclassified lines are shown as INFO."
        >
            Explicit levels / HTTP status
        </span>
        <span class="shrink-0">
            {loading
                ? "00:00:00.000"
                : logs.length || start !== undefined
                  ? logTime(chartEnd)
                  : ""}
        </span>
    </div>
</section>
