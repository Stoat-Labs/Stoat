<script lang="ts">
    import type { StepState } from "$lib/deployments/steps";
    import Check from "phosphor-svelte/lib/CheckIcon";
    import Loader from "phosphor-svelte/lib/CircleNotchIcon";
    import Minus from "phosphor-svelte/lib/MinusIcon";
    import X from "phosphor-svelte/lib/XIcon";

    let {
        state,
        retrying = false,
    }: { state: StepState | "cancelled"; retrying?: boolean } =
        $props();
</script>

{#if state === "active"}
    <Loader
        class="size-3.5 text-info-foreground motion-safe:animate-spin"
        aria-hidden="true"
    />
{:else if state === "done"}
    <Check
        class="size-3.5 text-success-foreground"
        aria-hidden="true"
    />
{:else if state === "error"}
    <X
        class="size-3.5 text-destructive-foreground"
        aria-hidden="true"
    />
{:else}
    <Minus
        class="size-3.5 {retrying
            ? 'text-warning-foreground'
            : 'text-muted-foreground'}"
        aria-hidden="true"
    />
{/if}
