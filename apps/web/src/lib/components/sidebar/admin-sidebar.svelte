<script lang="ts">
    import { page } from "$app/state";
    import {
        Sidebar,
        SidebarContent,
        SidebarFooter,
        SidebarGroup,
        SidebarGroupContent,
        SidebarGroupLabel,
        SidebarHeader,
        SidebarMenu,
        SidebarMenuButton,
        SidebarMenuItem,
        SidebarRail,
        SidebarSeparator,
    } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import ChartColumn from "@lucide/svelte/icons/chart-column";
    import Settings from "@lucide/svelte/icons/settings-2";
    import Shield from "@lucide/svelte/icons/shield";
    import SidebarNavLink from "./sidebar-nav-link.svelte";
    import UserMenu from "./user-menu.svelte";

    const {
        user,
    }: {
        user: {
            name: string;
            email: string;
            image?: string | null;
            role?: string | null;
        };
    } = $props();

    const sidebar = useSidebar();

    const navigation = [
        { title: "Overview", href: "/admin", icon: ChartColumn },
        {
            title: "Settings",
            href: "/admin/settings",
            icon: Settings,
        },
    ];

    function closeNavigation() {
        sidebar.setOpenMobile(false);
    }
</script>

<Sidebar variant="inset" collapsible="icon">
    <SidebarHeader>
        <SidebarMenu>
            <SidebarMenuItem>
                <SidebarMenuButton
                    size="lg"
                    tooltipContent="Back to app"
                >
                    {#snippet child({ props })}
                        <a
                            {...props}
                            href="/"
                            onclick={closeNavigation}
                        >
                            <img
                                src="/stoat.png"
                                alt="Stoat"
                                class="size-8 shrink-0 rounded-lg group-data-[collapsible=icon]:size-6"
                            />
                            <span
                                class="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden"
                            >
                                <span class="font-semibold">
                                    Back to app
                                </span>
                                <span class="text-xs">
                                    Exit admin area
                                </span>
                            </span>
                        </a>
                    {/snippet}
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
        <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each navigation as item (item.href)}
                        <SidebarNavLink
                            href={item.href}
                            icon={item.icon}
                            active={page.url.pathname === item.href}
                            tooltip={item.title}
                            onclick={closeNavigation}
                        >
                            {item.title}
                        </SidebarNavLink>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
    </SidebarContent>
    <SidebarSeparator />
    <SidebarFooter>
        <p
            class="flex items-center gap-2 px-2 text-xs font-medium text-destructive-foreground group-data-[collapsible=icon]:hidden"
        >
            <Shield class="size-4" aria-hidden="true" />Admin Mode
        </p>
        <SidebarMenu>
            <SidebarMenuItem><UserMenu {user} /></SidebarMenuItem>
        </SidebarMenu>
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
