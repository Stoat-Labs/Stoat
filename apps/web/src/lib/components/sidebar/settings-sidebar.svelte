<script lang="ts">
    import {
        activeSection,
        sectionParser,
        settingsGroups,
    } from "$lib/components/settings/settings-sections";
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
    import { useQueryState } from "nuqs-svelte";
    import SidebarAppFooter from "./sidebar-footer.svelte";
    import SidebarNavLink from "./sidebar-nav-link.svelte";

    const {
        user,
        organizations,
        activeOrganizationId,
    }: {
        user: {
            name: string;
            email: string;
            image?: string | null;
            role?: string | null;
        };
        organizations: { id: string; name: string; role: string }[];
        activeOrganizationId?: string | null;
    } = $props();

    const sidebar = useSidebar();

    function closeNavigation() {
        sidebar.setOpenMobile(false);
    }

    const groups = $derived(
        settingsGroups(
            organizations.find(
                (organization) =>
                    organization.id === activeOrganizationId,
            ),
        ),
    );

    const section = useQueryState("section", sectionParser);

    const active = $derived(activeSection(groups, section.current));
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
                                    Exit settings
                                </span>
                            </span>
                        </a>
                    {/snippet}
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    </SidebarHeader>
    <SidebarContent class="overflow-x-hidden">
        {#each groups as group, index (group.label)}
            {#if index > 0}<SidebarSeparator />{/if}
            <SidebarGroup>
                <SidebarGroupLabel class="truncate">
                    {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                    <SidebarMenu>
                        {#each group.items as item (item.value)}
                            <SidebarNavLink
                                href="/settings?section={item.value}"
                                icon={item.icon}
                                active={item.value === active}
                                tooltip={item.label}
                                onclick={closeNavigation}
                            >
                                {item.label}
                            </SidebarNavLink>
                        {/each}
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        {/each}
    </SidebarContent>
    <SidebarFooter>
        <SidebarAppFooter {user} />
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
