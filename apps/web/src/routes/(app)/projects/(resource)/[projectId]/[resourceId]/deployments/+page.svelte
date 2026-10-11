<script lang="ts">
    import { page } from "$app/state";
    import DeploymentsTable from "$lib/components/deployments/deployments-table.svelte";
    import { orpc } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: {
                projectId: page.params.projectId ?? "",
                resourceId: page.params.resourceId ?? "",
            },
        }),
    );
</script>

<svelte:head>
    <title>
        Deployments / {resourceQuery.data?.name ?? "Resource"} / Stoat
    </title>
</svelte:head>

{#key page.params.resourceId}
    <DeploymentsTable resourceId={page.params.resourceId} />
{/key}
