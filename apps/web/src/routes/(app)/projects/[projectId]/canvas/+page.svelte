<script lang="ts">
    import { page } from "$app/state";
    import ProjectCanvas from "$lib/components/canvas/project-canvas.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { subscribeToStream } from "$lib/deployments/stream";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import LayoutList from "@lucide/svelte/icons/layout-list";
    import { createQuery } from "@tanstack/svelte-query";
    import { onMount } from "svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const graphQuery = createQuery(() =>
        orpc.resources.getProjectGraph.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    // Read every query's status and data on each run, like the project page does. Short-circuiting
    // on `.data` left the canvas on its skeleton after some fresh loads, with all three queries done.
    const loaded = $derived.by(() => {
        const ready = [projectQuery, resourcesQuery, graphQuery].map(
            (query) => query.isSuccess,
        );

        const project = projectQuery.data;
        const resources = resourcesQuery.data;
        const graph = graphQuery.data;

        return ready.every(Boolean) && project && resources && graph
            ? { project, resources, graph }
            : undefined;
    });

    const error = $derived(
        projectQuery.error ??
            resourcesQuery.error ??
            graphQuery.error,
    );

    let watchError = $state("");

    useHeaderActions(listViewAction);

    onMount(() =>
        // A finished deployment can change both status and the deployed Compose services.
        subscribeToStream(
            (signal) =>
                client.cluster.watchDeployments(undefined, {
                    signal,
                }),
            () => {
                watchError = "";
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                });
            },
            (streamError, reconnecting) => {
                watchError = `${streamError.message || "Live updates unavailable."}${reconnecting ? " Reconnecting..." : " Reload the page to reconnect."}`;
            },
        ),
    );
</script>

<svelte:head>
    <title>
        {projectQuery.data?.name ?? "Project"} canvas / Stoat
    </title>
</svelte:head>

{#snippet listViewAction()}
    <Button size="sm" variant="ghost" href="/projects/{projectId}">
        <LayoutList class="size-4" aria-hidden="true" />
        List view
    </Button>
{/snippet}

<div
    class="flex h-[calc(100dvh-7rem)] w-full flex-col gap-3 pt-4 xl:h-auto xl:min-h-0 xl:flex-1"
>
    {#if watchError}
        <Alert variant="warning">
            <AlertDescription>{watchError}</AlertDescription>
        </Alert>
    {/if}

    {#if error}
        <Alert variant="error">
            <AlertDescription>
                Unable to load the canvas: {error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <div
            class="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border"
        >
            {#if loaded}
                <ProjectCanvas
                    {projectId}
                    clusterId={loaded.project.clusterId}
                    resources={loaded.resources}
                    graph={loaded.graph.resources}
                    logos={loaded.graph.logos}
                />
            {:else}
                <Skeleton
                    loading
                    loading-label="Loading canvas"
                    class="block size-full"
                >
                    <div
                        class="flex size-full items-center justify-center gap-24 p-8"
                    >
                        {#each { length: 3 }, column (column)}
                            <div class="flex flex-col gap-12">
                                {#each { length: column === 1 ? 2 : 1 }, row (row)}
                                    <div
                                        class="h-21 w-60 rounded-xl border border-border"
                                    ></div>
                                {/each}
                            </div>
                        {/each}
                    </div>
                </Skeleton>
            {/if}
        </div>
    {/if}
</div>
