<script lang="ts">
    import { page } from "$app/state";
    import ResourceSettingsView from "$lib/components/projects/resource-settings-view.svelte";
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
        Settings / {resourceQuery.data?.name ?? "Resource"} / Stoat
    </title>
</svelte:head>

<ResourceSettingsView {projectId} {resourceId} />
