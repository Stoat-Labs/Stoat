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
        SidebarRail,
        SidebarSeparator,
    } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import FolderOpen from "phosphor-svelte/lib/FolderOpenIcon";
    import GitBranch from "phosphor-svelte/lib/GitBranchIcon";
    import HardDrive from "phosphor-svelte/lib/DatabaseIcon";
    import LayoutDashboard from "phosphor-svelte/lib/HouseIcon";
    import Rocket from "phosphor-svelte/lib/RocketIcon";
    import Server from "phosphor-svelte/lib/HardDrivesIcon";
    import Settings from "phosphor-svelte/lib/GearSixIcon";
    import Shield from "phosphor-svelte/lib/ShieldCheckIcon";
    import OrgSwitcher from "./org-switcher.svelte";
    import ObservabilityNav from "./observability-nav.svelte";
    import SidebarAppFooter from "./sidebar-footer.svelte";
    import SidebarNavLink from "./sidebar-nav-link.svelte";

    let {
        variant = "inset",
        user,
        organizations,
        activeOrganizationId,
    }: {
        variant?: "sidebar" | "floating" | "inset";
        user: {
            name: string;
            email: string;
            image?: string | null;
            role?: string | null;
        };
        organizations: { id: string; name: string; slug: string }[];
        activeOrganizationId?: string | null;
    } = $props();

    const sidebar = useSidebar();

    function closeNavigation() {
        sidebar.setOpenMobile(false);
    }

    const pathname = $derived(page.url.pathname);

    const mainLinks = [
        { title: "Home", url: "/", icon: LayoutDashboard },
        { title: "Projects", url: "/projects", icon: FolderOpen },
        { title: "Deployments", url: "/deployments", icon: Rocket },
    ];

    const configLinks = [
        { title: "Clusters", url: "/clusters", icon: Server },
        { title: "Git", url: "/git", icon: GitBranch },
        { title: "S3 connections", url: "/s3", icon: HardDrive },
        { title: "Settings", url: "/settings", icon: Settings },
    ];

    const isAdmin = $derived(user.role === "admin");
</script>

<Sidebar {variant} collapsible="icon">
    <SidebarHeader>
        <OrgSwitcher
            {organizations}
            {activeOrganizationId}
            onNavigate={closeNavigation}
        />
    </SidebarHeader>
    <SidebarContent class="overflow-x-hidden">
        <SidebarGroup>
            <SidebarGroupLabel>Main</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each mainLinks as link (link.url)}
                        <SidebarNavLink
                            href={link.url}
                            title={link.title}
                            icon={link.icon}
                            active={link.url === "/"
                                ? pathname === "/"
                                : pathname.startsWith(link.url)}
                            current={pathname === link.url}
                            onclick={closeNavigation}
                        >
                            {link.title}
                        </SidebarNavLink>
                    {/each}
                    <ObservabilityNav onNavigate={closeNavigation} />
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
            <SidebarGroupLabel>Configuration</SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each configLinks as link (link.url)}
                        <SidebarNavLink
                            href={link.url}
                            title={link.title}
                            icon={link.icon}
                            active={pathname.startsWith(link.url)}
                            current={pathname === link.url}
                            onclick={closeNavigation}
                        >
                            {link.title}
                        </SidebarNavLink>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        {#if isAdmin}
            <SidebarSeparator />
            <SidebarGroup>
                <SidebarGroupLabel>Admin</SidebarGroupLabel>
                <SidebarGroupContent>
                    <SidebarMenu>
                        <SidebarNavLink
                            href="/admin"
                            title="Admin"
                            icon={Shield}
                            active={pathname.startsWith("/admin")}
                            current={pathname === "/admin"}
                            onclick={closeNavigation}
                        >
                            Admin
                        </SidebarNavLink>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        {/if}
    </SidebarContent>
    <SidebarFooter>
        <SidebarAppFooter {user} />
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
