<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Popover,
        PopoverContent,
        PopoverTrigger,
    } from "$lib/components/ui/popover";
    import {
        rangePresets,
        type RangePreset,
    } from "@stoat/api/observability";
    import Check from "@lucide/svelte/icons/check";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Clock from "@lucide/svelte/icons/clock";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import type { ObservabilityRangeState } from "./range";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    let {
        range,
        paused = $bindable(false),
        fetching,
        disabled = false,
        onrefresh,
    }: {
        range: ObservabilityRangeState;
        paused?: boolean;
        fetching: boolean;
        disabled?: boolean;
        onrefresh: () => void;
    } = $props();

    const rangeOpen = useQueryState(
        "rangeOpen",
        parseAsBoolean.withDefault(false),
    );

    const id = $props.id();

    let draftFrom = $state("");

    let draftTo = $state("");

    // datetime-local wants local wall-clock time without a zone.
    function toLocalInput(seconds: number) {
        const date = new Date(seconds * 1000);
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());

        return date.toISOString().slice(0, 16);
    }

    function formatRange(value: { from: number; to: number }) {
        const format = (seconds: number) =>
            new Date(seconds * 1000).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            });

        return `${format(value.from)} – ${format(value.to)}`;
    }

    function presetLabel(preset: RangePreset) {
        const count = parseInt(preset, 10);
        const unit = preset.endsWith("h") ? "hour" : "day";

        return `Last ${count} ${unit}${count === 1 ? "" : "s"}`;
    }

    function openRange(open: boolean) {
        rangeOpen.set(open);

        if (!open) return;
        const now = Math.floor(Date.now() / 1000);

        const seconds =
            parseInt(range.filters.range.current, 10) *
            (range.filters.range.current.endsWith("h")
                ? 3600
                : 86400);

        draftFrom = toLocalInput(range.custom?.from ?? now - seconds);
        draftTo = toLocalInput(range.custom?.to ?? now);
    }

    const draftValid = $derived(
        Boolean(draftFrom && draftTo) &&
            new Date(draftTo).getTime() -
                new Date(draftFrom).getTime() >=
                60_000,
    );

    function applyCustom(event: SubmitEvent) {
        event.preventDefault();

        if (!draftValid) return;
        void range.filters.set({
            from: Math.floor(new Date(draftFrom).getTime() / 1000),
            to: Math.floor(new Date(draftTo).getTime() / 1000),
        });
        rangeOpen.set(false);
    }
</script>

<Popover bind:open={() => rangeOpen.current, openRange}>
    <PopoverTrigger
        class={buttonVariants({
            variant: "outline",
            size: "sm",
            class: "max-w-[min(24rem,calc(100vw-2rem))]",
        })}
        aria-label="Select time range"
        title={range.custom
            ? formatRange(range.custom)
            : presetLabel(range.filters.range.current)}
    >
        <Clock class="size-4 shrink-0" aria-hidden="true" />
        <span class="truncate">
            {range.custom
                ? formatRange(range.custom)
                : presetLabel(range.filters.range.current)}
        </span>
        <ChevronDown
            class="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
        />
    </PopoverTrigger>
    <PopoverContent
        align="end"
        class="w-[30rem] max-w-[calc(100vw-2rem)] rounded-2xl [&>[data-slot=popover-viewport]]:p-1"
    >
        <Frame
            class="grid gap-1 sm:grid-cols-[minmax(0,1fr)_10rem] bg-transparent"
        >
            <section class="flex min-w-0 flex-col">
                <FrameHeader class="px-3 py-2">
                    <FrameTitle>Custom range</FrameTitle>
                </FrameHeader>
                <FramePanel class="flex-1 p-3">
                    <form
                        class="space-y-3 relative h-full"
                        onsubmit={applyCustom}
                    >
                        <div>
                            <div class="space-y-1.5">
                                <Label for={`${id}-from`}>
                                    From
                                </Label><Input
                                    id={`${id}-from`}
                                    type="datetime-local"
                                    bind:value={draftFrom}
                                    max={draftTo}
                                    required
                                />
                            </div>
                            <div class="space-y-1.5">
                                <Label for={`${id}-to`}>
                                    To
                                </Label><Input
                                    id={`${id}-to`}
                                    type="datetime-local"
                                    bind:value={draftTo}
                                    min={draftFrom}
                                    required
                                />
                            </div>
                            <p class="text-xs text-muted-foreground">
                                Local browser time
                            </p>
                            {#if draftFrom && draftTo && !draftValid}<p
                                    class="text-xs text-destructive-foreground"
                                    role="alert"
                                >
                                    The range must span at least one
                                    minute.
                                </p>{/if}
                        </div>
                        <Button
                            type="submit"
                            size="sm"
                            class="w-full absolute bottom-0"
                            disabled={!draftValid}
                        >
                            Apply range
                        </Button>
                    </form>
                </FramePanel>
            </section>
            <section class="flex min-w-0 flex-col">
                <FrameHeader class="px-3 py-2">
                    <FrameTitle>Quick ranges</FrameTitle>
                </FrameHeader>
                <FramePanel
                    class="grid flex-1 grid-cols-2 content-start gap-0.5 p-1 sm:grid-cols-1"
                >
                    {#each rangePresets as preset (preset)}
                        <Button
                            variant={!range.custom &&
                            range.filters.range.current === preset
                                ? "secondary"
                                : "ghost"}
                            size="sm"
                            class="w-full justify-between"
                            aria-pressed={!range.custom &&
                                range.filters.range.current ===
                                    preset}
                            onclick={() => {
                                void range.filters.set({
                                    range: preset,
                                    from: null,
                                    to: null,
                                });
                                void rangeOpen.set(false);
                            }}
                        >
                            {presetLabel(preset)}
                            {#if !range.custom && range.filters.range.current === preset}<Check
                                    class="size-3.5"
                                    aria-hidden="true"
                                />{/if}
                        </Button>
                    {/each}
                </FramePanel>
            </section>
        </Frame>
    </PopoverContent>
</Popover>
<Button
    variant="ghost"
    size="sm"
    aria-pressed={paused}
    disabled={!!range.custom}
    title={range.custom
        ? "Auto-refresh is off for fixed ranges"
        : paused
          ? "Resume updates every 30 seconds"
          : "Updates every 30 seconds; click to pause"}
    onclick={() => (paused = !paused)}
>
    <span
        class={range.custom || paused
            ? "size-1.5 rounded-full bg-muted-foreground"
            : "size-1.5 rounded-full bg-success-foreground"}
        aria-hidden="true"
    ></span>
    {range.custom ? "Fixed range" : paused ? "Paused" : "Live"}
</Button>
<Button
    variant="outline"
    size="icon-sm"
    aria-label="Refresh metrics"
    disabled={fetching || disabled}
    onclick={onrefresh}
>
    <RefreshCw
        class={fetching
            ? "size-4 animate-spin motion-reduce:animate-none"
            : "size-4"}
    />
</Button>
