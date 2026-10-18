<!-- Railway's variables header: the count and search on the left, actions on the right. -->
<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import Search from "@lucide/svelte/icons/search";
    import type { Snippet } from "svelte";

    let {
        count,
        search,
        onsearch,
        children,
    }: {
        count: number;
        /** `null` while the search field is closed. */
        search: string | null;
        onsearch: (value: string | null) => void;
        children?: Snippet;
    } = $props();
</script>

<div class="flex flex-wrap items-center gap-3">
    <h3 class="text-lg font-medium">
        {count}
        {count === 1 ? "Service Variable" : "Service Variables"}
    </h3>
    {#if search === null}
        <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Search variables"
            onclick={() => onsearch("")}
        >
            <Search class="size-4" aria-hidden="true" />
        </Button>
    {:else}
        <Input
            value={search}
            oninput={(event) => onsearch(event.currentTarget.value)}
            onkeydown={(event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onsearch(null);
                }
            }}
            placeholder="Search variables"
            aria-label="Search variables"
            class="h-8 w-48"
            autofocus
        />
    {/if}
    {#if children}
        <div class="ml-auto flex items-center gap-2">
            {@render children()}
        </div>
    {/if}
</div>
