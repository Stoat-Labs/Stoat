<script lang="ts">
    import { page } from "$app/state";
    import CanvasShell from "$lib/components/canvas/canvas-shell.svelte";
    import CanvasSidebar from "$lib/components/canvas/canvas-sidebar.svelte";
    import AppShell from "$lib/components/sidebar/app-shell.svelte";
    import AppSidebar from "$lib/components/sidebar/sidebar.svelte";
    import AdminSidebar from "$lib/components/sidebar/admin-sidebar.svelte";
    import SettingsSidebar from "$lib/components/sidebar/settings-sidebar.svelte";
    import SearchPalette from "$lib/components/search/search-palette.svelte";

    const { children, data } = $props();

    // The canvas and the project's other rail pages keep Railway's frame.
    const canvasShell = $derived(
        page.route.id === "/(app)/projects/[projectId]/canvas" ||
            page.route.id === "/(app)/projects/[projectId]/metrics",
    );

    const fullPage = $derived(
        page.route.id === "/(app)/deployments/[deploymentId]" ||
            page.route.id === "/(app)/observability/services",
    );
</script>

{#if canvasShell}
    <CanvasShell {children}>
        {#snippet sidebar()}
            <CanvasSidebar
                user={data.user}
                organizations={data.organizations}
                activeOrganizationId={data.activeOrganizationId}
            />
        {/snippet}
    </CanvasShell>
{:else}
    <AppShell
        {children}
        fullWidth={fullPage ||
            page.url.pathname === "/" ||
            page.url.pathname === "/deployments" ||
            page.url.pathname === "/observability" ||
            page.url.pathname.startsWith("/observability/")}
        fullHeight={fullPage}
    >
        {#snippet sidebar()}
            {#if page.url.pathname === "/admin" || page.url.pathname.startsWith("/admin/")}
                <AdminSidebar user={data.user} />
            {:else if page.url.pathname === "/settings"}
                <SettingsSidebar
                    user={data.user}
                    organizations={data.organizations}
                    activeOrganizationId={data.activeOrganizationId}
                />
            {:else}
                <AppSidebar
                    user={data.user}
                    organizations={data.organizations}
                    activeOrganizationId={data.activeOrganizationId}
                />
            {/if}
        {/snippet}
    </AppShell>
{/if}

<SearchPalette />
