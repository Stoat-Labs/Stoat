<!-- Railway's list view of projects: one row per project, its resources as small tiles. -->
<script lang="ts">
    import {
        projectStatus,
        type ProjectCardResource,
    } from "./project-card.svelte";
    import ProjectStar from "./project-star.svelte";
    import ResourceTile from "./resource-tile.svelte";

    let {
        name,
        resources,
        clusterName,
        href,
        favorite = false,
        onfavorite,
    }: {
        name: string;
        resources: ProjectCardResource[];
        clusterName?: string;
        href?: string;
        favorite?: boolean;
        onfavorite?: (favorite: boolean) => void;
    } = $props();

    const MAX_TILES = 6;

    const tiles = $derived(resources.slice(0, MAX_TILES));

    const { summary, dot } = $derived(projectStatus(resources));
</script>

<article
    class="group relative flex min-w-0 items-center gap-4 rounded-xl border bg-card px-4 py-3 transition-colors hover:border-input"
    data-slot="project-row"
>
    <h3
        class="w-48 min-w-0 shrink-0 truncate text-[15px] font-semibold"
    >
        {#if href}
            <a
                {href}
                class="before:absolute before:inset-0 before:rounded-xl focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring"
            >
                {name}
            </a>
        {:else}
            {name}
        {/if}
    </h3>
    <ul
        class="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex"
        aria-label="Resources"
    >
        {#each tiles as resource (resource.id)}
            <ResourceTile {resource} size="sm" />
        {/each}
        {#if resources.length > tiles.length}
            <li
                class="ps-1 text-xs text-muted-foreground tabular-nums"
            >
                +{resources.length - tiles.length}
            </li>
        {/if}
    </ul>
    <p
        class="ms-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
    >
        <span
            class={["size-1.5 shrink-0 rounded-full", dot]}
            aria-hidden="true"
        ></span>
        <span class="truncate">
            {#if resources.length === 0}
                No resources
            {:else}
                {#if clusterName}
                    {clusterName}
                    <span aria-hidden="true">·</span>
                {/if}
                {summary}
            {/if}
        </span>
    </p>
    <ProjectStar {name} {favorite} {onfavorite} />
</article>
