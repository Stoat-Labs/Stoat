<script lang="ts">
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ProjectCanvas from "$lib/components/canvas/project-canvas.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        streamErrorToast,
        subscribeToStream,
    } from "$lib/deployments/stream";
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
            // Poll while a bucket job runs, so a deleted bucket leaves the canvas.
            refetchInterval: (query) =>
                query.state.data?.some(
                    (resource) =>
                        resource.bucketStatus === "provisioning" ||
                        resource.bucketStatus === "deleting",
                )
                    ? 2_000
                    : false,
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

    const watchToast = streamErrorToast();

    onMount(() => {
        // A finished deployment can change both status and the deployed Compose services.
        const stop = subscribeToStream(
            (signal) =>
                watchToast.connected(
                    client.cluster.watchDeployments(undefined, {
                        signal,
                    }),
                ),
            () => {
                watchToast.clear();
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
            (streamError, reconnecting) =>
                watchToast.show(streamError, reconnecting),
        );

        return () => {
            stop();
            watchToast.clear();
        };
    });
</script>

<svelte:head>
    <title>
        {projectQuery.data?.name ?? "Project"} canvas / Stoat
    </title>
</svelte:head>

<!-- Fills the canvas shell's card. -->
<div class="flex min-h-0 flex-1 flex-col">
    {#if error}
        <Alert variant="error" class="mx-3 mt-3 w-auto">
            <AlertDescription>
                Unable to load the canvas: {error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <div class="relative min-h-0 flex-1 overflow-hidden">
            {#if loaded}
                <ProjectCanvas
                    {projectId}
                    clusterId={loaded.project.clusterId}
                    isInternal={loaded.project.isInternal === true}
                    resources={loaded.resources}
                    graph={loaded.graph.resources}
                    logos={loaded.graph.logos}
                    layout={loaded.project.canvasLayout ?? {}}
                />
            {:else}
                <!-- The exact SVG Svelte Flow draws for project-canvas's dots (gap 24, size 0.6, default #91919a), behind one card shaped like card-node. -->
                <div
                    class="relative flex size-full items-center justify-center"
                >
                    <svg
                        class="absolute inset-0 size-full"
                        aria-hidden="true"
                    >
                        <pattern
                            id="canvas-loading-dots"
                            width="24"
                            height="24"
                            patternUnits="userSpaceOnUse"
                            patternTransform="translate(-0.3,-0.3)"
                        >
                            <circle
                                cx="0.3"
                                cy="0.3"
                                r="0.3"
                                fill="#91919a"
                            />
                        </pattern>
                        <rect
                            width="100%"
                            height="100%"
                            fill="url(#canvas-loading-dots)"
                        />
                    </svg>
                    <Skeleton
                        loading
                        label="Loading canvas"
                        class="relative"
                    >
                        <div
                            class="flex h-36 w-72 flex-col justify-between rounded-xl border border-foreground/14 bg-card p-6 shadow-xs/5"
                        >
                            <div class="flex items-start gap-3">
                                <span
                                    class="size-6 shrink-0 rounded-md"
                                ></span>
                                <div class="flex flex-col gap-1">
                                    <p
                                        class="w-fit text-base font-semibold"
                                    >
                                        Service name
                                    </p>
                                    <p class="w-fit text-sm">
                                        example.com
                                    </p>
                                </div>
                            </div>
                            <div
                                class="grid grid-cols-[24px_1fr] items-center gap-3"
                            >
                                <span
                                    class="mx-auto size-2 rounded-full"
                                ></span>
                                <p class="w-fit text-sm">Online</p>
                            </div>
                        </div>
                    </Skeleton>
                </div>
            {/if}
        </div>
    {/if}
</div>
