<!-- One row of a variables list: icon, name, the value cell, and a trailing menu or action. -->
<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        name,
        description,
        icon,
        children,
        menu,
    }: {
        name: string;
        /** Shown under the name; such rows are taller and have no icon column. */
        description?: string;
        icon?: Snippet;
        /** The value cell, or a form spanning it and the menu. */
        children: Snippet;
        menu?: Snippet;
    } = $props();
</script>

<li
    class={[
        "group grid items-center gap-4 rounded-md px-4 hover:bg-accent/50",
        icon
            ? "min-h-10 grid-cols-[16px_minmax(0,2fr)_minmax(0,3fr)_32px]"
            : "min-h-14 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] py-1.5",
    ]}
>
    {#if icon}{@render icon()}{/if}
    <div class="min-w-0">
        <p class="truncate font-mono text-sm" title={name}>{name}</p>
        {#if description}
            <p
                class="truncate text-xs text-muted-foreground"
                title={description}
            >
                {description}
            </p>
        {/if}
    </div>
    {@render children()}
    {#if menu}{@render menu()}{/if}
</li>
