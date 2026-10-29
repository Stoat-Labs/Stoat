<!--
    Railway's canvas frame: an icon rail, a slim top bar with the project switcher and the page's
    actions, and the canvas as a card below it. The rail's logo heads the same top row.
-->
<script lang="ts">
    import { page } from "$app/state";
    import { orpc } from "$lib/api/orpc";
    import { buttonVariants } from "$lib/components/ui/button";
    import {
        Menu,
        MenuGroup,
        MenuGroupLabel,
        MenuLinkItem,
        MenuPopup,
        MenuSeparator,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        SidebarInset,
        SidebarProvider,
        SidebarTrigger,
    } from "$lib/components/ui/sidebar";
    import { setHeaderActions } from "$lib/components/sidebar/header-actions";
    import Check from "@lucide/svelte/icons/check";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import { createQuery } from "@tanstack/svelte-query";
    import type { Snippet } from "svelte";

    let {
        children,
        sidebar,
    }: {
        children: Snippet;
        sidebar: Snippet;
    } = $props();

    // Pages register their header actions as usual; this shell shows them in its top bar.
    const headerActions = $state<{ content?: Snippet }>({});

    setHeaderActions(headerActions);

    const projectId = $derived(page.params.projectId ?? "");

    // Switching projects keeps you on the same rail page.
    const view = $derived(
        page.route.id === "/(app)/projects/[projectId]/metrics"
            ? "metrics"
            : "canvas",
    );

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjects.queryOptions(),
    );

    const project = $derived(
        projectsQuery.data?.find(
            (candidate) => candidate.id === projectId,
        ),
    );
</script>

<!-- Always collapsed: opening it would only cover the canvas. Phones still slide it in. -->
<SidebarProvider
    bind:open={() => false, () => {}}
    class="h-dvh min-h-0"
    style="--sidebar-width-icon: 2.875rem"
>
    {@render sidebar()}
    <!-- The inset only lays out the bar and the card; the card is the visible surface. -->
    <!--
        A 2px start margin (not the inset's 8px) leaves the same gap on both sides of the rail
        buttons: the sidebar's container is 2px wider than the space it reserves.
    -->
    <SidebarInset
        class="min-h-0 bg-transparent! shadow-none! md:peer-data-[variant=inset]:peer-data-[state=collapsed]:my-0 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-0.5"
    >
        <header
            class="relative flex h-14 shrink-0 items-center gap-2 px-2"
        >
            <SidebarTrigger class="md:hidden" />
            <Menu>
                <MenuTrigger
                    class={buttonVariants({
                        variant: "ghost",
                        size: "sm",
                        class: "min-w-0 gap-1.5 font-medium data-popup-open:bg-accent",
                    })}
                    aria-label="Switch project"
                >
                    <span class="truncate">
                        {project?.name ?? "Project"}
                    </span>
                    <ChevronDown
                        class="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                </MenuTrigger>
                <MenuPopup align="start" class="min-w-56">
                    <MenuGroup>
                        <MenuGroupLabel>Projects</MenuGroupLabel>
                        {#each projectsQuery.data ?? [] as candidate (candidate.id)}
                            <MenuLinkItem
                                href="/projects/{candidate.id}/{view}"
                            >
                                <span class="min-w-0 flex-1 truncate">
                                    {candidate.name}
                                </span>
                                {#if candidate.id === projectId}
                                    <Check
                                        class="size-4"
                                        aria-label="Current project"
                                    />
                                {/if}
                            </MenuLinkItem>
                        {/each}
                    </MenuGroup>
                    <MenuSeparator />
                    <MenuLinkItem href="/projects">
                        <FolderOpen aria-hidden="true" />
                        All projects
                    </MenuLinkItem>
                </MenuPopup>
            </Menu>
            {#if headerActions.content}
                <div class="ms-auto flex shrink-0 items-center gap-1">
                    {@render headerActions.content()}
                </div>
            {/if}
        </header>
        <!-- The canvas bleeds to the card's edges; other rail pages scroll inside it. -->
        <div
            class={[
                "relative mb-2 flex min-h-0 flex-1 flex-col rounded-xl border bg-background shadow-sm/5 max-md:mx-2",
                view === "canvas"
                    ? "overflow-hidden"
                    : "overflow-y-auto p-4",
            ]}
        >
            {#key page.url.pathname}
                {@render children()}
            {/key}
        </div>
    </SidebarInset>
</SidebarProvider>
