<script lang="ts" module>
    import type { ProjectCardResource } from "$lib/components/projects/project-card.svelte";

    export type ResourceStatus = ProjectCardResource["status"];

    export type ProjectOverview = {
        id: string;
        name: string;
        description: string | null;
        clusterId: string;
        clusterName: string;
        favorite: boolean;
        lastActivityAt: Date | string;
        resources: (ProjectCardResource & {
            template: string | null;
        })[];
    };

    export const statusLabels: Record<
        Exclude<ResourceStatus, null>,
        string
    > = {
        queued: "Deploy queued",
        running: "Deploying",
        ready: "Deployed",
        failed: "Deploy failed",
        cancelled: "Deploy cancelled",
    };

    export function dotClass(status: ResourceStatus) {
        switch (status) {
            case "ready":
                return "bg-success";
            case "failed":
                return "bg-destructive";
            case "queued":
            case "running":
                return "animate-pulse bg-warning";
            default:
                return "bg-muted-foreground/40";
        }
    }
</script>

<script lang="ts">
    import {
        createCanvasModeQuery,
        projectHref,
    } from "$lib/api/canvas-mode.svelte";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ProjectCard from "$lib/components/projects/project-card.svelte";
    import ProjectRow from "$lib/components/projects/project-row.svelte";
    import { createQuery } from "@tanstack/svelte-query";

    let {
        project,
        showCluster = true,
        layout = "grid",
    }: {
        project: ProjectOverview;
        showCluster?: boolean;
        /** Railway's grid of cards, or its list of rows. */
        layout?: "grid" | "list";
    } = $props();

    const View = $derived(
        layout === "list" ? ProjectRow : ProjectCard,
    );

    const canvasModeQuery = createCanvasModeQuery();

    // One cached list for every card; the canvas palette reads the same one.
    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions(),
    );

    // An uploaded icon wins, then the logo of the template the image runs, as on the canvas.
    const resources = $derived(
        project.resources.map((resource) => ({
            ...resource,
            icon:
                resource.icon ??
                templatesQuery.data?.find(
                    (template) =>
                        template.appId === resource.template,
                )?.logo ??
                null,
        })),
    );

    // Shown at once; the list refetches to settle the order.
    let starred = $state<boolean | null>(null);

    async function setFavorite(favorite: boolean) {
        starred = favorite;

        try {
            await client.projects.setFavorite({
                projectId: project.id,
                favorite,
            });
            await queryClient.invalidateQueries({
                queryKey: orpc.projects.listProjectOverviews.key(),
            });
        } finally {
            starred = null;
        }
    }
</script>

<View
    name={project.name}
    {resources}
    clusterName={showCluster ? project.clusterName : undefined}
    href={projectHref(project.id, canvasModeQuery.data.canvasMode)}
    favorite={starred ?? project.favorite}
    onfavorite={(favorite: boolean) => void setFavorite(favorite)}
/>
