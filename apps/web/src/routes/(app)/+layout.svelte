<script lang="ts">
    import { page } from "$app/state";
    import AppShell from "$lib/components/sidebar/app-shell.svelte";
    import AppSidebar from "$lib/components/sidebar/sidebar.svelte";

    const { children, data } = $props();

    const fullPage = $derived(page.route.id === "/(app)/deployments/[deploymentId]");
</script>

{#if page.params.resourceId}
    {@render children()}
{:else}
    <AppShell {children} fullWidth={fullPage || page.url.pathname === "/observability"} fullHeight={fullPage}>
        {#snippet sidebar()}
            <AppSidebar user={data.user} organizations={data.organizations} activeOrganizationId={data.activeOrganizationId} />
        {/snippet}
    </AppShell>
{/if}
