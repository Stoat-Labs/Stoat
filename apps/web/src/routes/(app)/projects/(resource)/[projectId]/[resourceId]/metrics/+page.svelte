<script lang="ts">
    import { page } from "$app/state";
    import ResourceMetricsView from "$lib/components/projects/resource-metrics-view.svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");
</script>

<svelte:head><title>Metrics / Stoat</title></svelte:head>

<ResourceMetricsView {projectId} {resourceId} />
