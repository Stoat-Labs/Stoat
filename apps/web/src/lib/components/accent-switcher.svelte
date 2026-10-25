<script lang="ts">
    import {
        ToggleGroup,
        ToggleGroupItem,
    } from "$lib/components/ui/toggle-group";
    import { accent, accents, setAccent } from "$lib/theme.svelte";
    import { onMount } from "svelte";

    // The server can't read this device's accent, so show it only after hydration.
    let ready = $state(false);

    onMount(() => {
        ready = true;
    });
</script>

<ToggleGroup
    variant="outline"
    size="sm"
    aria-label="Accent color"
    value={ready ? [accent.current] : []}
    onValueChange={(next) => {
        // Pressing the active swatch would clear the group; keep the current accent then.
        const value = accents.find((item) => item.value === next[0]);

        if (value) setAccent(value.value);
    }}
>
    {#each accents as option (option.value)}
        <ToggleGroupItem
            value={option.value}
            aria-label={option.label}
            title={option.label}
            disabled={!ready}
        >
            <span
                class="size-3.5 rounded-full border border-foreground/16"
                style:background={option.color}
            ></span>
        </ToggleGroupItem>
    {/each}
</ToggleGroup>
