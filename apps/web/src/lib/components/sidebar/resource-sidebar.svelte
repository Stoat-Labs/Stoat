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
    import { orpc } from "$lib/orpc";
    import Activity from "@lucide/svelte/icons/activity";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Braces from "@lucide/svelte/icons/braces";
    import Container from "@lucide/svelte/icons/container";
    import Globe from "@lucide/svelte/icons/globe";
    import Rocket from "@lucide/svelte/icons/rocket";
    import Settings from "@lucide/svelte/icons/settings-2";
    import ScrollText from "@lucide/svelte/icons/scroll-text";
    import { createQuery } from "@tanstack/svelte-query";
    import OrgSwitcher from "./org-switcher.svelte";
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

    const projectBase = $derived(`/projects/${projectId}`);

    const resourceBase = $derived(
        `/projects/${projectId}/${resourceId}`,
    );

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: Boolean(projectId),
        }),
    );

    // Name-only reuse of the warmed resources cache (ResourceList below
    // holds the same query, so this triggers no extra request).
    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: Boolean(projectId),
        }),
    );

    const projectName = $derived(
        projectQuery.data?.name ?? "Project",
    );

    const resourceItem = $derived(
        resourcesQuery.data?.find((item) => item.id === resourceId),
    );

    const resourceName = $derived(resourceItem?.name ?? "Resource");

    const showSettings = $derived(!projectQuery.data?.isInternal);

    type ResourceLink = {
        title: string;
        href: string;
        icon: typeof Container;
        active: boolean;
        current?: boolean;
    };

    const overviewLink = $derived<ResourceLink>({
        title: "Overview",
        href: resourceBase,
        icon: Container,
        active: pathname === resourceBase,
    });

    const variablesLink = $derived<ResourceLink>({
        title: "Variables",
        href: `${resourceBase}/variables`,
        icon: Braces,
        active: pathname === `${resourceBase}/variables`,
    });

    const settingsLinks = $derived<ResourceLink[]>(
        showSettings
            ? [
                  {
                      title: "Settings",
                      href: `${resourceBase}/settings`,
                      icon: Settings,
                      active: pathname === `${resourceBase}/settings`,
                  },
              ]
            : [],
    );

    // Buckets have no containers, so only overview, variables, and settings apply.
    const resourceLinks = $derived<ResourceLink[]>(
        resourceItem?.type === "bucket"
            ? [overviewLink, variablesLink, ...settingsLinks]
            : [
                  overviewLink,
                  variablesLink,
                  {
                      title: "Ingress",
                      href: `${resourceBase}/ingress`,
                      icon: Globe,
                      active: pathname === `${resourceBase}/ingress`,
                  },
                  {
                      title: "Deployments",
                      href: `${resourceBase}/deployments`,
                      icon: Rocket,
                      active:
                          pathname ===
                              `${resourceBase}/deployments` ||
                          pathname.startsWith(
                              `${resourceBase}/deployments/`,
                          ),
                      current:
                          pathname === `${resourceBase}/deployments`,
                  },
                  {
                      title: "Metrics",
                      href: `${resourceBase}/metrics`,
                      icon: Activity,
                      active: pathname === `${resourceBase}/metrics`,
                  },
                  {
                      title: "Logs",
                      href: `${resourceBase}/logs`,
                      icon: ScrollText,
                      active: pathname === `${resourceBase}/logs`,
                  },
                  ...settingsLinks,
              ],
    );
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
            <SidebarGroupLabel class="truncate">
                {projectName}
            </SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    <SidebarNavLink
                        href={projectBase}
                        title="Back to {projectName}"
                        icon={ArrowLeft}
                        active={false}
                        onclick={closeNavigation}
                    >
                        Back to project
                    </SidebarNavLink>
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
            <SidebarGroupLabel class="truncate">
                {resourceName}
            </SidebarGroupLabel>
            <SidebarGroupContent>
                <SidebarMenu>
                    {#each resourceLinks as link (link.href)}
                        <SidebarNavLink
                            href={link.href}
                            title={link.title === "Settings"
                                ? "Resource settings"
                                : link.title === "Overview"
                                  ? "Resource overview"
                                  : link.title}
                            icon={link.icon}
                            active={link.active}
                            current={link.current ?? link.active}
                            onclick={closeNavigation}
                        >
                            {link.title}
                        </SidebarNavLink>
                    {/each}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator />
        <SidebarGroup>
            <SidebarGroupLabel>Resources</SidebarGroupLabel>
            <SidebarGroupContent>
                <ResourceList
                    highlightCurrent={false}
                    onNavigate={closeNavigation}
                />
            </SidebarGroupContent>
        </SidebarGroup>
    </SidebarContent>
    <SidebarFooter>
        <SidebarAppFooter {user} />
    </SidebarFooter>
    <SidebarRail />
</Sidebar>
