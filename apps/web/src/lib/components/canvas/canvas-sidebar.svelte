<!-- Railway's project rail: only the project's own views, with the account at the edges. -->
<script lang="ts">
    import { page } from "$app/state";
    import { orpc } from "$lib/api/orpc";
    import EditProjectDialog from "$lib/components/projects/edit-project-dialog.svelte";
    import SidebarAppFooter from "$lib/components/sidebar/sidebar-footer.svelte";
    import {
        Sidebar,
        SidebarContent,
        SidebarFooter,
        SidebarGroup,
        SidebarGroupContent,
        SidebarHeader,
        SidebarMenu,
        SidebarMenuButton,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import ChartColumn from "@lucide/svelte/icons/chart-column";
    import Network from "@lucide/svelte/icons/network";
    import Settings from "@lucide/svelte/icons/settings";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    let {
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
        organizations: { id: string; name: string; slug: string }[];
        activeOrganizationId?: string | null;
    } = $props();

    const sidebar = useSidebar();

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    // The same URL flag as the regular header's edit button, so links keep working.
    const editProject = useQueryState(
        "editProject",
        parseAsBoolean.withDefault(false),
    );

    const links = $derived([
        {
            title: "Canvas",
            href: `/projects/${projectId}/canvas`,
            icon: Network,
        },
        {
            title: "Metrics",
            href: `/projects/${projectId}/metrics`,
            icon: ChartColumn,
        },
    ]);

    // Railway's rail: 40px squares with 20px icons, roomier than the regular icon sidebar.
    const railButton =
        "group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-2.5! [&>svg]:size-5";

    // The logo and the account menu, centred in the rail like its buttons.
    const edgeRow =
        "px-0 [&_[data-sidebar=menu-item]]:flex [&_[data-sidebar=menu-item]]:justify-center";

    function closeNavigation() {
        sidebar.setOpenMobile(false);
    }
</script>

<Sidebar variant="inset" collapsible="icon">
    <SidebarHeader class={edgeRow}>
        <a href="/" class="w-full flex items-center justify-center">
            <img src="/stoat.png" class=" size-8" alt="logo" />
        </a>
    </SidebarHeader>
    <SidebarContent class="overflow-x-hidden">
        <SidebarGroup class="px-0">
            <SidebarGroupContent>
                <SidebarMenu class="items-center gap-2">
                    {#each links as link (link.title)}
                        {@const active =
                            page.url.pathname === link.href}
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                class={railButton}
                                isActive={active}
                                tooltipContent={link.title}
                            >
                                {#snippet child({ props })}
                                    <a
                                        {...props}
                                        href={link.href}
                                        aria-current={active
                                            ? "page"
                                            : undefined}
                                        onclick={closeNavigation}
                                    >
                                        <link.icon
                                            aria-hidden="true"
                                        />
                                        <span>{link.title}</span>
                                    </a>
                                {/snippet}
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    {/each}
                    {#if project && !project.isInternal}
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                class={railButton}
                                tooltipContent="Project settings"
                                isActive={editProject.current}
                                onclick={() => {
                                    closeNavigation();
                                    editProject.current = true;
                                }}
                            >
                                <Settings aria-hidden="true" />
                                <span>Project settings</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    {/if}
                </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
    </SidebarContent>
    <SidebarFooter class={edgeRow}>
        <SidebarAppFooter {user} />
    </SidebarFooter>
</Sidebar>

{#if project}
    <EditProjectDialog bind:open={editProject.current} {project} />
{/if}
