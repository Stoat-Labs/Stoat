<script lang="ts">
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { CommandItem } from "$lib/components/ui/command";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import type { Entry } from "./add-palette-entries";

    let {
        entry,
        creating,
        onchoose,
    }: {
        entry: Entry;
        creating: boolean;
        onchoose: (entry: Entry) => void;
    } = $props();

    // Docker Hub logos 404 for repositories without one; those rows show `icon` instead.
    let brokenLogo = $state<string | null>(null);
</script>

<CommandItem
    value={entry}
    disabled={creating}
    class="min-h-11 gap-3 rounded-lg px-3 py-3 text-muted-foreground data-highlighted:text-foreground sm:min-h-11"
    onclick={() => onchoose(entry)}
>
    {#if entry.provider}
        <ProviderIcon provider={entry.provider} />
    {:else if entry.logo && entry.logo !== brokenLogo}
        {@const logo = entry.logo}
        <img
            src={logo}
            alt=""
            aria-hidden="true"
            class="size-4 shrink-0 object-contain"
            onerror={() => (brokenLogo = logo)}
        />
    {:else}
        <entry.icon class="size-4 shrink-0" aria-hidden="true" />
    {/if}
    <span class="min-w-0 flex-1">
        <span class="block truncate">
            {entry.label}
        </span>
        {#if entry.description}
            <span
                class="block truncate text-xs text-muted-foreground"
            >
                {entry.description}
            </span>
        {/if}
    </span>
    {#if "page" in entry.target}
        <ChevronRight class="size-4 shrink-0" aria-hidden="true" />
    {:else if creating}
        <span class="text-xs">Adding...</span>
    {/if}
</CommandItem>
