<!-- Opens the search palette; the rail and the regular sidebar both show one. -->
<script lang="ts">
    import { Kbd, KbdGroup } from "$lib/components/ui/kbd";
    import {
        SidebarMenuButton,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import Search from "phosphor-svelte/lib/MagnifyingGlassIcon";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    let { class: className = "" }: { class?: string } = $props();

    const open = useQueryState(
        "palette",
        parseAsBoolean.withDefault(false),
    );
</script>

<SidebarMenuItem>
    <SidebarMenuButton
        class={className}
        tooltipContent="Search (Ctrl K)"
        onclick={() => void open.set(true)}
    >
        <Search aria-hidden="true" />
        <span class="group-data-[collapsible=icon]:hidden">
            Search
        </span>
        <KbdGroup
            class="ms-auto group-data-[collapsible=icon]:hidden max-md:hidden"
        >
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
        </KbdGroup>
    </SidebarMenuButton>
</SidebarMenuItem>
