<script lang="ts">
    import { page } from "$app/state";
    import DeploymentViewer from "$lib/components/deployments/deployment-viewer.svelte";
</script>

<DeploymentViewer
    deploymentId={page.params.deploymentId ?? ""}
    backHref={`/projects/${page.params.projectId}/${page.params.resourceId}/deployments`}
/>
