<script lang="ts">
    import {
        ToggleGroup,
        ToggleGroupItem,
    } from "$lib/components/ui/toggle-group";
    import {
        setTheme,
        theme,
        themeLabels,
        themes,
    } from "$lib/theme.svelte";
    import Monitor from "@lucide/svelte/icons/monitor";
    import Moon from "@lucide/svelte/icons/moon";
    import Sun from "@lucide/svelte/icons/sun";
    import { onMount } from "svelte";

    const options = [
        { value: "dark", icon: Moon },
        { value: "light", icon: Sun },
        { value: "system", icon: Monitor },
    ] as const;

    // The server can't read this device's theme, so show it only after hydration.
    let ready = $state(false);

    onMount(() => {
        ready = true;
    });
</script>

<ToggleGroup
    variant="outline"
    size="sm"
    aria-label="Theme"
    value={ready ? [theme.current] : []}
    onValueChange={(next) => {
        // Pressing the active button would clear the group; keep the current theme then.
        const value = themes.find((item) => item === next[0]);

        if (value) setTheme(value);
    }}
>
    {#each options as option (option.value)}
        {@const Icon = option.icon}
        <ToggleGroupItem
            value={option.value}
            aria-label={themeLabels[option.value]}
            title={themeLabels[option.value]}
            disabled={!ready}
        >
            <Icon aria-hidden="true" />
        </ToggleGroupItem>
    {/each}
</ToggleGroup>
