<script lang="ts">
    import { page } from "$app/state";
    import DeploymentsTable from "$lib/components/deployments/deployments-table.svelte";
</script>

<svelte:head><title>Deployments / Stoat</title></svelte:head>

{#key page.params.resourceId}
    <DeploymentsTable resourceId={page.params.resourceId} />
{/key}
