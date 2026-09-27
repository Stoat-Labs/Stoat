<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
    import { rangePresets } from "@stoat/api/observability";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import type { ObservabilityRangeState } from "./range";

    let { range, paused = $bindable(false), fetching, disabled = false, onrefresh }: { range: ObservabilityRangeState; paused?: boolean; fetching: boolean; disabled?: boolean; onrefresh: () => void } = $props();

    let customOpen = $state(false);

    let draftFrom = $state("");

    let draftTo = $state("");

    // datetime-local wants local wall-clock time without a zone.
    function toLocalInput(seconds: number) {
        const date = new Date(seconds * 1000);
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());

        return date.toISOString().slice(0, 16);
    }

    function formatRange(value: { from: number; to: number }) {
        const format = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

        return `${format(value.from)} – ${format(value.to)}`;
    }

    function openCustom(open: boolean) {
        customOpen = open;

        if (!open) return;
        const now = Math.floor(Date.now() / 1000);
        draftFrom = toLocalInput(range.custom?.from ?? now - 3600);
        draftTo = toLocalInput(range.custom?.to ?? now);
    }

    const draftValid = $derived(Boolean(draftFrom && draftTo) && new Date(draftTo).getTime() - new Date(draftFrom).getTime() >= 60_000);

    function applyCustom(event: SubmitEvent) {
        event.preventDefault();

        if (!draftValid) return;
        void range.filters.set({ from: Math.floor(new Date(draftFrom).getTime() / 1000), to: Math.floor(new Date(draftTo).getTime() / 1000) });
        customOpen = false;
    }
</script>

<div class="flex flex-wrap items-center gap-1 rounded-lg border p-0.5" role="group" aria-label="Time range">
    {#each rangePresets as preset (preset)}<Button variant={!range.custom && range.filters.range.current === preset ? "secondary" : "ghost"} size="sm" class="h-7 px-2.5" aria-pressed={!range.custom && range.filters.range.current === preset} onclick={() => void range.filters.set({ range: preset, from: null, to: null })}>{preset}</Button>{/each}
    <Popover bind:open={() => customOpen, openCustom}>
        <PopoverTrigger class={buttonVariants({ variant: range.custom ? "secondary" : "ghost", size: "sm", class: "h-7 px-2.5" })} aria-pressed={!!range.custom}>{range.custom ? formatRange(range.custom) : "Custom"}<ChevronDown class="ml-1 size-4" /></PopoverTrigger>
        <PopoverContent align="end" class="w-72 p-3">
            <form class="space-y-3" onsubmit={applyCustom}>
                <div class="space-y-1.5"><Label for="range-from">From</Label><Input id="range-from" type="datetime-local" bind:value={draftFrom} max={draftTo} required /></div>
                <div class="space-y-1.5"><Label for="range-to">To</Label><Input id="range-to" type="datetime-local" bind:value={draftTo} min={draftFrom} required /></div>
                {#if draftFrom && draftTo && !draftValid}<p class="text-xs text-destructive" role="alert">The range must span at least one minute.</p>{/if}
                <Button type="submit" size="sm" class="w-full" disabled={!draftValid}>Apply range</Button>
            </form>
        </PopoverContent>
    </Popover>
</div>
<Button variant="outline" size="sm" aria-pressed={paused} disabled={!!range.custom} onclick={() => (paused = !paused)}>{range.custom ? "Fixed range" : paused ? "Paused" : "Live · 30s"}</Button>
<Button variant="outline" size="icon-sm" aria-label="Refresh metrics" disabled={fetching || disabled} onclick={onrefresh}><RefreshCw class={fetching ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} /></Button>
