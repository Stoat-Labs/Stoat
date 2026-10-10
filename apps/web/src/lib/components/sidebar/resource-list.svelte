<script lang="ts">
    import { page } from "$app/state";
    import Boxes from "@lucide/svelte/icons/boxes";
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import { orpc } from "$lib/api/orpc";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        SidebarMenu,
        SidebarMenuButton,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import { createQuery } from "@tanstack/svelte-query";

    let {
        highlightCurrent,
        onNavigate,
    }: {
        highlightCurrent: boolean;
        onNavigate: () => void;
    } = $props();

    const pathname = $derived(page.url.pathname);

    const projectId = $derived(page.params.projectId);

    // Reuses the TanStack cache warmed by the layout and the detail pages,
    // so this doesn't trigger extra requests.
    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: projectId ?? "" },
            enabled: Boolean(projectId),
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);
</script>

{#if resourcesQuery.isPending}
    <Skeleton
        loading
        count={2}
        count-gap={8}
        class="mx-2"
        loading-label="Loading resources"
    >
        <div class="flex h-7 items-center gap-2 rounded-lg px-2">
            <Boxes class="size-4" aria-hidden="true" />
            <span class="truncate text-sm">Resource service</span>
        </div>
    </Skeleton>
{:else if resources.length === 0}
    <p
        class="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
    >
        No resources yet.
    </p>
{:else}
    <SidebarMenu>
        {#each resources as resource (resource.id)}
            {@const href = `/projects/${projectId}/${resource.id}`}
            {@const current = highlightCurrent && pathname === href}
            <SidebarMenuItem>
                <SidebarMenuButton isActive={current}>
                    {#snippet child({ props })}
                        <a
                            {...props}
                            onclick={onNavigate}
                            {href}
                            title={resource.name}
                            aria-current={current
                                ? "page"
                                : undefined}
                        >
                            {#if resource.icon}
                                <img
                                    src={resource.icon}
                                    alt=""
                                    class="size-4 shrink-0 rounded object-contain"
                                />
                            {:else if resource.type === "bucket"}
                                <BucketIcon aria-hidden="true" />
                            {:else}
                                <Boxes aria-hidden="true" />
                            {/if}
                            <span>{resource.name}</span>
                        </a>
                    {/snippet}
                </SidebarMenuButton>
            </SidebarMenuItem>
        {/each}
    </SidebarMenu>
{/if}
