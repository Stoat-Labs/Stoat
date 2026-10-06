<script lang="ts">
    import ClusterUsageRow from "$lib/components/home/cluster-usage-row.svelte";
    import DeploymentsTable from "$lib/components/deployments/deployments-table.svelte";
    import ProjectOverviewCard from "$lib/components/home/project-overview-card.svelte";
    import CreateProjectDialog from "$lib/components/projects/create-project-dialog.svelte";
    import ProjectCard from "$lib/components/projects/project-card.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { orpc, queryClient } from "$lib/orpc";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import Plus from "@lucide/svelte/icons/plus";
    import Search from "@lucide/svelte/icons/search";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { onMount } from "svelte";

    const params = useQueryStates(
        {
            q: parseAsString.withDefault(""),
            dialog: parseAsString,
            cluster: parseAsString.withDefault("all"),
            sort: parseAsStringLiteral([
                "recent",
                "name",
                "attention",
            ]).withDefault("recent"),
        },
        { shallow: true, scroll: false },
    );

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjectOverviews.queryOptions(),
    );

    const clustersQuery = createQuery(() =>
        orpc.cluster.listClusters.queryOptions({
            input: { limit: 100, includeDiagnostics: false },
            refetchInterval: 60_000,
        }),
    );

    // Load health independently: one slow sidecar must not hide the list or delay usage.
    const healthQueries = createQueries(() => ({
        queries: (clustersQuery.data?.items ?? []).map((cluster) =>
            orpc.cluster.healthz.queryOptions({
                input: { clusterId: cluster.id },
                refetchInterval: 60_000,
                staleTime: 30_000,
                retry: false,
            }),
        ),
    }));

    const projects = $derived(projectsQuery.data ?? []);

    const filtered = $derived.by(() => {
        const q = params.q.current.trim().toLowerCase();

        const matches = projects.filter(
            (project) =>
                (params.cluster.current === "all" ||
                    project.clusterId === params.cluster.current) &&
                (!q ||
                    [
                        project.name,
                        project.description ?? "",
                        project.clusterName,
                        ...project.resources.map((r) => r.name),
                    ].some((value) =>
                        value.toLowerCase().includes(q),
                    )),
        );

        return matches.sort((a, b) => {
            if (params.sort.current === "name")
                return a.name.localeCompare(b.name);

            if (params.sort.current === "attention") {
                const failures =
                    b.resources.filter(
                        (resource) => resource.status === "failed",
                    ).length -
                    a.resources.filter(
                        (resource) => resource.status === "failed",
                    ).length;

                if (failures) return failures;
            }

            return (
                new Date(b.lastActivityAt).getTime() -
                new Date(a.lastActivityAt).getTime()
            );
        });
    });

    const clusters = $derived(
        (clustersQuery.data?.items ?? []).map((cluster, index) => ({
            ...cluster,
            diagnostics: healthQueries[index]?.data ?? null,
            diagnosticsPending:
                healthQueries[index]?.isPending ?? true,
        })),
    );

    const clusterItems = $derived([
        { value: "all", label: "All clusters" },
        ...clusters.map((cluster) => ({
            value: cluster.id,
            label: cluster.name,
        })),
    ]);

    const sortItems = [
        { value: "recent", label: "Recent activity" },
        { value: "name", label: "Name" },
        { value: "attention", label: "Failed deployments first" },
    ];

    const resourceCount = $derived(
        projects.reduce(
            (count, project) => count + project.resources.length,
            0,
        ),
    );

    const failedResources = $derived(
        projects.flatMap((project) => {
            const failed = [];

            for (const resource of project.resources) {
                if (resource.status === "failed")
                    failed.push({ project, resource });
            }

            return failed;
        }),
    );

    const degradedClusters = $derived(
        clusters.filter(
            (cluster) => cluster.diagnostics?.status === "degraded",
        ),
    );

    let ready = $state(false);

    useHeaderActions(homeActions);

    onMount(() => {
        ready = true;

        return () => {
            ready = false;
        };
    });

    function openCreate() {
        void params.set({ dialog: "create-project" });
    }

    function refreshOverview() {
        void queryClient
            .cancelQueries({
                queryKey: orpc.projects.listProjectOverviews.key(),
            })
            .then(() =>
                queryClient.invalidateQueries({
                    queryKey:
                        orpc.projects.listProjectOverviews.key(),
                }),
            );
        void queryClient.invalidateQueries({
            queryKey: orpc.cluster.listClusters.key(),
        });
    }
</script>

<svelte:head><title>Home / Stoat</title></svelte:head>

{#snippet homeActions()}
    <div
        class="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2"
    >
        <InputGroup class="w-40 sm:w-64">
            <InputGroupInput
                type="search"
                placeholder="Search projects…"
                aria-label="Search projects"
                bind:value={
                    () => params.q.current,
                    (q) => {
                        void params.set({ q: q || null });
                    }
                }
            />
            <InputGroupAddon align="inline-start">
                <Search aria-hidden="true" />
            </InputGroupAddon>
        </InputGroup>
        <Button size="sm" disabled={!ready} onclick={openCreate}>
            <Plus class="size-4" aria-hidden="true" />
            Create project
        </Button>
    </div>
{/snippet}

<div class="w-full space-y-6 pt-6">
    <!-- <section aria-labelledby="overview-title" class="space-y-2">
        <h1 id="overview-title" class="text-2xl font-semibold">
            Overview
        </h1>
        <div
            class="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground"
        >
            <span>
                {projectsQuery.data ? projects.length : "—"} projects
            </span>
            <span>
                {projectsQuery.data ? resourceCount : "—"} resources
            </span>
            <span>
                {clustersQuery.data ? clustersQuery.data.total : "—"} clusters
            </span>
            {#if projectsQuery.data}
                <span
                    class={failedResources.length
                        ? "text-destructive-foreground"
                        : ""}
                >
                    {failedResources.length} failed {failedResources.length ===
                    1
                        ? "deployment"
                        : "deployments"}
                </span>
            {/if}
        </div>
    </section> -->

    {#if failedResources.length || degradedClusters.length}
        <Frame>
            <FrameHeader>
                <FrameTitle><h2>Needs attention</h2></FrameTitle>
            </FrameHeader>
            <FramePanel class="p-0">
                <ul class="divide-y divide-border">
                    {#each failedResources as item (item.resource.id)}
                        <li
                            class="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                            <p class="min-w-0 text-sm">
                                <span class="font-medium break-all">
                                    {item.project.name} / {item
                                        .resource.name}
                                </span>
                                <span
                                    class="ml-2 text-destructive-foreground"
                                >
                                    Deployment failed
                                </span>
                            </p>
                            <Button
                                size="sm"
                                variant="ghost"
                                href="/projects/{item.project
                                    .id}/{item.resource
                                    .id}/deployments"
                            >
                                View deployments <ArrowRight
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </Button>
                        </li>
                    {/each}
                    {#each degradedClusters as cluster (cluster.id)}
                        <li
                            class="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                            <p class="min-w-0 text-sm">
                                <span class="font-medium break-all">
                                    {cluster.name}
                                </span>
                                <span
                                    class="ml-2 text-warning-foreground"
                                >
                                    Cluster degraded
                                </span>
                            </p>
                            <Button
                                size="sm"
                                variant="ghost"
                                href="/clusters/{cluster.id}"
                            >
                                View cluster <ArrowRight
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </Button>
                        </li>
                    {/each}
                </ul>
            </FramePanel>
        </Frame>
    {/if}

    <section aria-labelledby="projects-title" class="space-y-3">
        <div
            class="flex flex-wrap items-center justify-between gap-3"
        >
            <h2 id="projects-title" class="text-base font-semibold">
                Projects
            </h2>
            <div class="flex max-w-full flex-wrap gap-2">
                <Select
                    items={clusterItems}
                    bind:value={
                        () => params.cluster.current,
                        (cluster) => {
                            void params.set({ cluster });
                        }
                    }
                >
                    <SelectTrigger
                        aria-label="Filter projects by cluster"
                        class="w-40"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {#each clusterItems as item (item.value)}<SelectItem
                                value={item.value}
                                label={item.label}
                            >
                                {item.label}
                            </SelectItem>{/each}
                    </SelectContent>
                </Select>
                <Select
                    items={sortItems}
                    bind:value={
                        () => params.sort.current,
                        (sort) => {
                            if (
                                sort === "recent" ||
                                sort === "name" ||
                                sort === "attention"
                            )
                                void params.set({ sort });
                        }
                    }
                >
                    <SelectTrigger
                        aria-label="Sort projects"
                        class="w-48"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {#each sortItems as item (item.value)}<SelectItem
                                value={item.value}
                                label={item.label}
                            >
                                {item.label}
                            </SelectItem>{/each}
                    </SelectContent>
                </Select>
            </div>
        </div>
        {#if projectsQuery.isPending}
            <Skeleton loading loading-label="Loading projects">
                <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {#each { length: 3 }, index (index)}
                        <li class="min-w-0">
                            <ProjectCard
                                name="Project workspace"
                                description="Project resources and environments"
                                resourceCount={3}
                                clusterName={params.cluster
                                    .current === "all"
                                    ? "Cluster name"
                                    : undefined}
                            />
                        </li>
                    {/each}
                </ul>
            </Skeleton>
        {:else if projectsQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    Unable to load projects: {projectsQuery.error
                        .message}
                </AlertDescription>
            </Alert>
        {:else if projects.length === 0}
            <Empty
                class="rounded-xl border border-dashed border-border"
            >
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <FolderOpen aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No projects yet</EmptyTitle>
                    <EmptyDescription>
                        Create your first project to get started.
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button
                        size="sm"
                        disabled={!ready}
                        onclick={openCreate}
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        Create project
                    </Button>
                </EmptyContent>
            </Empty>
        {:else if filtered.length === 0}
            <p
                class="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
            >
                No projects match these filters.
                <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => {
                        void params.set({ q: null, cluster: null });
                    }}
                >
                    Clear filters
                </Button>
            </p>
        {:else}
            <ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {#each filtered as project (project.id)}
                    <li class="min-w-0">
                        <ProjectOverviewCard
                            {project}
                            showCluster={params.cluster.current ===
                                "all"}
                        />
                    </li>
                {/each}
            </ul>
        {/if}
    </section>

    <Frame class="min-w-0">
        <FrameHeader
            class="flex-row flex-wrap items-center justify-between gap-2 py-3"
        >
            <div class="min-w-0">
                <FrameTitle class="text-base">
                    <h2>Clusters</h2>
                </FrameTitle>
                <FrameDescription class="mt-0.5">
                    Current resource usage across each cluster's
                    machines.
                </FrameDescription>
            </div>
            <Button size="sm" variant="ghost" href="/clusters">
                View all
                <ArrowRight class="size-4" aria-hidden="true" />
            </Button>
        </FrameHeader>
        <FramePanel class="overflow-hidden p-0">
            {#if clustersQuery.isPending}
                <Skeleton loading loading-label="Loading clusters">
                    <div
                        class="grid gap-6 px-5 py-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
                    >
                        <div class="space-y-1.5">
                            <p class="text-sm font-semibold">
                                Cluster name
                            </p>
                            <p class="text-xs">
                                2 machines · 2 projects
                            </p>
                        </div>
                        <div class="grid gap-4 sm:grid-cols-3">
                            {#each ["CPU", "Memory", "Disk"] as label (label)}
                                <div class="space-y-1.5">
                                    <p class="text-xs">{label}</p>
                                    <p class="text-sm">0 / 0 units</p>
                                    <div
                                        class="h-1.5 rounded-full bg-muted"
                                    ></div>
                                </div>
                            {/each}
                        </div>
                    </div>
                </Skeleton>
            {:else if clustersQuery.isError}
                <div
                    class="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                >
                    <p class="text-sm text-muted-foreground">
                        Unable to load clusters: {clustersQuery.error
                            .message}
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={clustersQuery.isFetching}
                        onclick={() => clustersQuery.refetch()}
                    >
                        Retry
                    </Button>
                </div>
            {:else if clusters.length}
                <ul class="divide-y divide-border">
                    {#each clusters as cluster (cluster.id)}
                        <ClusterUsageRow {cluster} />
                    {/each}
                </ul>
            {:else}
                <div
                    class="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                >
                    <p class="text-sm text-muted-foreground">
                        No clusters connected yet.
                    </p>
                    <Button
                        size="sm"
                        variant="outline"
                        href="/clusters"
                    >
                        Connect a cluster
                    </Button>
                </div>
            {/if}
        </FramePanel>
    </Frame>

    <DeploymentsTable
        latest={5}
        onDeploymentChange={refreshOverview}
    />
</div>

<CreateProjectDialog
    bind:open={
        () => params.dialog.current === "create-project",
        (open) => {
            if (
                ready &&
                !open &&
                params.dialog.current === "create-project"
            )
                void params.set({ dialog: null });
        }
    }
/>
