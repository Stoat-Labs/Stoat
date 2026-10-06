<script lang="ts">
    import { page } from "$app/state";
    import { Separator } from "$lib/components/ui/separator";
    import {
        SidebarInset,
        SidebarProvider,
        SidebarTrigger,
    } from "$lib/components/ui/sidebar";
    import { orpc } from "$lib/orpc";
    import {
        observabilityHref,
        observabilityView,
    } from "$lib/observability-navigation";
    import EditProjectDialog from "$lib/components/projects/edit-project-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import Pencil from "@lucide/svelte/icons/pencil";
    import { createQuery } from "@tanstack/svelte-query";
    import { onMount } from "svelte";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import BreadcrumbTrail, {
        type Crumb,
    } from "./breadcrumb-trail.svelte";
    import { setHeaderActions } from "./header-actions";

    import type { Snippet } from "svelte";

    const {
        children,
        sidebar,
        fullWidth = false,
        fullHeight = false,
    }: {
        children: Snippet;
        sidebar: Snippet;
        fullWidth?: boolean;
        fullHeight?: boolean;
    } = $props();

    const headerActions = $state<{ content?: Snippet }>({});

    setHeaderActions(headerActions);

    const pageTitle = $derived(
        page.url.pathname.startsWith("/settings")
            ? "Settings"
            : page.url.pathname.startsWith("/observability")
              ? "Observability"
              : page.url.pathname.startsWith("/projects")
                ? "Projects"
                : page.url.pathname.startsWith("/clusters")
                  ? "Clusters"
                  : page.url.pathname.startsWith("/deployments")
                    ? "Deployments"
                    : page.url.pathname.startsWith("/git")
                      ? "Git"
                      : page.url.pathname.startsWith("/s3")
                        ? "S3 connections"
                        : "Home",
    );

    const monitoringView = $derived(
        observabilityView(page.url.pathname),
    );

    const deploymentId = $derived(page.params.deploymentId);

    // On a project detail route, show Projects › <name> in the header.
    // The projects list is shared from the TanStack cache, so this does not
    // trigger an extra request when the detail page loads it too.
    const projectId = $derived(page.params.projectId);

    const isProjectDetail = $derived(
        page.url.pathname.startsWith("/projects/") &&
            Boolean(projectId),
    );

    const isProjectScope = $derived(Boolean(projectId));

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: isProjectDetail || isProjectScope,
        }),
    );

    const project = $derived(projectQuery.data);

    const projectName = $derived(project?.name);

    const editProjectOpen = useQueryState(
        "editProject",
        parseAsBoolean.withDefault(false),
    );

    const resourceId = $derived(page.params.resourceId);

    const isResourceDetail = $derived(
        page.url.pathname.startsWith("/projects/") &&
            Boolean(projectId) &&
            Boolean(resourceId),
    );

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled:
                (isResourceDetail || isProjectScope) &&
                Boolean(projectId),
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);

    const resource = $derived(
        resources.find((r) => r.id === resourceId),
    );

    // /projects/:projectId/:resourceId/<tab> → "Deployments", "Settings", …
    const resourceTab = $derived.by(() => {
        const tab = isResourceDetail
            ? page.url.pathname.split("/")[4]
            : undefined;

        return tab ? tab[0].toUpperCase() + tab.slice(1) : undefined;
    });

    const isCreate = $derived(
        page.route.id?.startsWith(
            "/(app)/projects/[projectId]/create",
        ) === true,
    );

    const createSource = $derived(page.params.source);

    const createTemplatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions({
            enabled:
                isCreate &&
                Boolean(createSource) &&
                createSource !== "compose" &&
                createSource !== "git",
        }),
    );

    const createSourceLabel = $derived(
        createSource === "compose"
            ? "Compose"
            : createSource === "git"
              ? "Compose from Git"
              : createSource
                ? (createTemplatesQuery.data?.find(
                      (t) => t.appId === createSource,
                  )?.name ?? "…")
                : undefined,
    );

    const projectTab = $derived(
        page.url.pathname === `/projects/${projectId}/metrics`
            ? "Metrics"
            : isCreate
              ? "New resource"
              : undefined,
    );

    const clusterId = $derived(page.params.clusterId);

    const isClusterDetail = $derived(
        page.url.pathname.startsWith("/clusters/") &&
            Boolean(clusterId),
    );

    const clusterQuery = createQuery(() =>
        orpc.cluster.getCluster.queryOptions({
            input: { clusterId: clusterId ?? "" },
            enabled: isClusterDetail,
        }),
    );

    const clusterName = $derived(clusterQuery.data?.name);

    const trail = $derived.by((): Crumb[] => {
        const base = `/projects/${projectId}`;
        const shortId = deploymentId?.slice(0, 8) ?? "";

        if (deploymentId && !isResourceDetail)
            return [
                { label: "Deployments", href: "/deployments" },
                { label: shortId, mono: true },
            ];

        if (isClusterDetail)
            return [
                { label: "Clusters", href: "/clusters" },
                { label: clusterName ?? "…" },
            ];

        if (isResourceDetail)
            return [
                { label: "Projects", href: "/projects" },
                { label: projectName ?? "…", href: base },
                {
                    label: resource?.name ?? "…",
                    href: `${base}/${resourceId}`,
                    resource: { icon: resource?.icon },
                },
                ...(resourceTab
                    ? [
                          {
                              label: resourceTab,
                              href: `${base}/${resourceId}/deployments`,
                          },
                      ]
                    : []),
                ...(deploymentId
                    ? [{ label: shortId, mono: true }]
                    : []),
            ];

        if (isProjectDetail)
            return [
                { label: "Projects", href: "/projects" },
                {
                    label: projectName ?? "…",
                    href: base,
                    title: project?.description ?? undefined,
                },
                ...(projectTab
                    ? [{ label: projectTab, href: `${base}/create` }]
                    : []),
                ...(createSourceLabel
                    ? [{ label: createSourceLabel }]
                    : []),
            ];

        if (monitoringView)
            return [
                {
                    label: "Observability",
                    href: observabilityHref(
                        "/observability",
                        page.url,
                    ),
                },
                { label: monitoringView.title },
            ];

        if (
            page.url.pathname === "/admin" ||
            page.url.pathname.startsWith("/admin/")
        )
            return [
                { label: "Admin", href: "/admin" },
                ...(page.url.pathname === "/admin/settings"
                    ? [{ label: "Settings" }]
                    : []),
            ];

        return [{ label: pageTitle }];
    });

    // The toggle is client-only; keep it disabled until hydration so a fast
    // click can't land on an inert button.
    let ready = $state(false);

    onMount(() => {
        ready = true;
    });
</script>

<SidebarProvider
    class={fullHeight ? "xl:h-dvh xl:min-h-0" : undefined}
>
    {@render sidebar()}
    <SidebarInset
        class={fullHeight
            ? "min-h-0 overflow-visible border"
            : "overflow-visible border"}
    >
        <header
            class="group/header sticky top-0 z-40 flex min-h-16 rounded-t-xl shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-popover/80 px-4 py-2 backdrop-blur-lg"
        >
            <div class="flex min-w-0 max-w-full items-center gap-2">
                <SidebarTrigger disabled={!ready} />
                <Separator orientation="vertical" class="mx-2 h-4" />
                <BreadcrumbTrail {trail}>
                    {#snippet trailing()}
                        {#if isProjectDetail && !deploymentId && project && !project.isInternal && !projectTab}
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                class="opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
                                aria-label="Edit project"
                                onclick={() =>
                                    (editProjectOpen.current = true)}
                            >
                                <Pencil class="size-3.5" />
                            </Button>
                        {/if}
                    {/snippet}
                </BreadcrumbTrail>
            </div>
            {#if headerActions.content}
                <div class="ml-auto min-w-0 max-w-full shrink-0">
                    {@render headerActions.content()}
                </div>
            {/if}
        </header>
        <div
            class={[
                fullWidth
                    ? "w-full px-4 pb-4"
                    : "mx-auto w-full max-w-7xl px-4 pb-4",
                fullHeight &&
                    "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:overflow-y-auto",
            ]}
        >
            {#key page.url.pathname}
                {@render children?.()}
            {/key}
        </div>
    </SidebarInset>
</SidebarProvider>
{#if project}
    <EditProjectDialog
        bind:open={editProjectOpen.current}
        {project}
    />
{/if}
