<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import Pause from "@lucide/svelte/icons/pause";
    import Play from "@lucide/svelte/icons/play";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";

    let {
        status,
        warn,
        paused,
        reconnecting,
        ontogglepause,
        onreconnect,
    }: {
        status: string;
        /** Highlights a degraded stream even when the label is not "Live". */
        warn: boolean;
        paused: boolean;
        /** Disables the reconnect button while services are refetching. */
        reconnecting: boolean;
        ontogglepause: () => void;
        onreconnect: () => void;
    } = $props();
</script>

<span role="status">
    <Badge
        variant={status === "Live"
            ? "success"
            : warn
              ? "warning"
              : "secondary"}
    >
        {status}
    </Badge>
</span>
<Button variant="outline" size="sm" onclick={ontogglepause}>
    {#if paused}<Play
            class="size-3.5"
            aria-hidden="true"
        />Resume{:else}<Pause
            class="size-3.5"
            aria-hidden="true"
        />Pause{/if}
</Button>
<Button
    variant="ghost"
    size="icon-sm"
    aria-label="Reconnect live logs"
    title="Refresh services and reload recent tail"
    disabled={reconnecting}
    onclick={onreconnect}
>
    <RefreshCw class="size-3.5" aria-hidden="true" />
</Button>
