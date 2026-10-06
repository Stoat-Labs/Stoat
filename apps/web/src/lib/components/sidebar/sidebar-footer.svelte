<script lang="ts">
    import {
        SidebarMenu,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import UserMenu from "./user-menu.svelte";

    let {
        user,
    }: {
        user: {
            name: string;
            email: string;
            image?: string | null;
            role?: string | null;
        };
    } = $props();
</script>

<SidebarMenu>
    <SidebarMenuItem><UserMenu {user} /></SidebarMenuItem>
</SidebarMenu>
<p
    class="px-2 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
>
    v0.0.1
</p>
