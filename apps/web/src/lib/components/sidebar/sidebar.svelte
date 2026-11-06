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
    import { orpc } from "$lib/api/orpc";
    import Activity from "phosphor-svelte/lib/PulseIcon";
    import FolderOpen from "phosphor-svelte/lib/FolderOpenIcon";
    import GitBranch from "phosphor-svelte/lib/GitBranchIcon";
    import HardDrive from "phosphor-svelte/lib/DatabaseIcon";
    import LayoutDashboard from "phosphor-svelte/lib/HouseIcon";
    import Rocket from "phosphor-svelte/lib/RocketIcon";
    import Server from "phosphor-svelte/lib/HardDrivesIcon";
    import Settings from "phosphor-svelte/lib/GearSixIcon";
    import Shield from "phosphor-svelte/lib/ShieldCheckIcon";
    import { createQuery } from "@tanstack/svelte-query";
    import OrgSwitcher from "./org-switcher.svelte";
    import ObservabilityNav from "./observability-nav.svelte";
    import ResourceList from "./resource-list.svelte";
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

    // The queries below reuse the TanStack cache warmed by the layout and the
    // detail pages, so they don't trigger extra requests.
    const projectId = $derived(page.params.projectId);

    const resourceId = $derived(page.params.resourceId);

    const isProjectPage = $derived(Boolean(projectId) && !resourceId);

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: Boolean(projectId),
        }),
    );

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
        {#if isProjectPage}
            <SidebarSeparator />
            <SidebarGroup>
                <SidebarGroupLabel class="truncate">
                    {projectQuery.data?.name ?? "Project"}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                    <SidebarMenu>
                        <SidebarNavLink
                            href="/projects/{projectId}"
                            title="Project overview"
                            icon={FolderOpen}
                            active={pathname ===
                                `/projects/${projectId}`}
                            onclick={closeNavigation}
                        >
                            Overview
                        </SidebarNavLink>
                        <SidebarNavLink
                            href="/projects/{projectId}/metrics"
                            title="Project metrics"
                            icon={Activity}
                            active={pathname ===
                                `/projects/${projectId}/metrics`}
                            onclick={closeNavigation}
                        >
                            Metrics
                        </SidebarNavLink>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
            <SidebarGroup>
                <SidebarGroupLabel>Resources</SidebarGroupLabel>
                <SidebarGroupContent>
                    <ResourceList
                        highlightCurrent
                        onNavigate={closeNavigation}
                    />
                </SidebarGroupContent>
            </SidebarGroup>
        {/if}
    </SidebarContent>
    <SidebarFooter>
        <SidebarAppFooter {user} />
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
