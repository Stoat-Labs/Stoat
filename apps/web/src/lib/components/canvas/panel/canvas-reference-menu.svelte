<script lang="ts">
    import {
        Menu,
        MenuGroup,
        MenuGroupLabel,
        MenuItem,
        MenuPopup,
        MenuSub,
        MenuSubPopup,
        MenuSubTrigger,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import type { ReferenceTarget } from "$lib/components/variables/reference-options";
    import Braces from "@lucide/svelte/icons/braces";

    let {
        targets,
        loading,
        onpick,
    }: {
        targets: ReferenceTarget[];
        loading: boolean;
        /** Receives `{{ <resourceId>.KEY }}`, the form deploys resolve. */
        onpick: (reference: string) => void;
    } = $props();
</script>

<!-- Railway's `{}` button inside a value field: pick another resource's variable to reference. -->
<Menu>
    <MenuTrigger
        type="button"
        class="flex size-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Add a reference"
    >
        <Braces class="size-3.5" aria-hidden="true" />
    </MenuTrigger>
    <MenuPopup align="end" class="max-h-80 min-w-56">
        <MenuGroup>
            <MenuGroupLabel>Reference a variable</MenuGroupLabel>
            {#each targets as target (target.id)}
                <MenuSub>
                    <MenuSubTrigger disabled={!target.keys.length}>
                        {target.name}
                    </MenuSubTrigger>
                    <MenuSubPopup class="max-h-80">
                        {#each target.keys as key (key)}
                            <MenuItem
                                class="font-mono"
                                onclick={() =>
                                    onpick(
                                        `{{ ${target.id}.${key} }}`,
                                    )}
                            >
                                {key}
                            </MenuItem>
                        {/each}
                    </MenuSubPopup>
                </MenuSub>
            {:else}
                <p class="px-2 py-1.5 text-sm text-muted-foreground">
                    {loading
                        ? "Loading resources..."
                        : "No other resources to reference."}
                </p>
            {/each}
        </MenuGroup>
    </MenuPopup>
</Menu>
