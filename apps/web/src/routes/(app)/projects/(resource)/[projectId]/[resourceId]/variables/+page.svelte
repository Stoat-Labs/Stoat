<script lang="ts">
    import { page } from "$app/state";
    import ResourceVariablesView from "$lib/components/projects/resource-variables-view.svelte";
    import { orpc } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: Boolean(projectId && resourceId),
        }),
    );
</script>

<svelte:head>
    <title>
        Variables / {resourceQuery.data?.name ?? "Resource"} / Stoat
    </title>
</svelte:head>

<ResourceVariablesView {projectId} {resourceId} />
