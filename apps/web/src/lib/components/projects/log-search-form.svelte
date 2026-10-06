<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import Search from "@lucide/svelte/icons/search";

    let {
        query = $bindable(""),
        range,
        start = $bindable(""),
        end = $bindable(""),
        pending = false,
        canSearch = false,
        retentionDays = null,
        timezone = "",
        onrange,
        onsubmit,
    }: {
        query: string;
        range: string;
        start: string;
        end: string;
        pending?: boolean;
        canSearch?: boolean;
        retentionDays?: number | null;
        timezone?: string;
        onrange: (value: string) => void;
        onsubmit: (event: SubmitEvent) => void;
    } = $props();
</script>

<form class="flex flex-col gap-2" {onsubmit}>
    <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-40 flex-1">
            <Input
                size="sm"
                type="search"
                aria-label="Search log messages"
                placeholder="Search messages (literal text)..."
                bind:value={query}
                maxlength={512}
            />
        </div>
        <label class="sr-only" for="log-range">Time range</label>
        <select
            id="log-range"
            class="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7"
            value={range}
            onchange={(event) => onrange(event.currentTarget.value)}
        >
            <option value="15m">Last 15 minutes</option>
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="custom">Custom range</option>
        </select>
        <Button
            size="sm"
            type="submit"
            loading={pending}
            disabled={pending || !canSearch}
        >
            <Search class="size-3.5" aria-hidden="true" />Search
        </Button>
    </div>
    {#if range === "custom"}
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div class="space-y-1">
                <Label for="log-start" class="text-xs">
                    From
                </Label><Input
                    id="log-start"
                    size="sm"
                    type="datetime-local"
                    step="1"
                    bind:value={start}
                    required
                />
            </div>
            <div class="space-y-1">
                <Label for="log-end" class="text-xs">
                    Until
                </Label><Input
                    id="log-end"
                    size="sm"
                    type="datetime-local"
                    step="1"
                    bind:value={end}
                    required
                />
            </div>
        </div>
    {/if}
    <p class="text-xs text-muted-foreground">
        {timezone}. {retentionDays
            ? `Up to ${retentionDays} days retained.`
            : "Within configured retention."}
        Current service IDs only.
    </p>
</form>
