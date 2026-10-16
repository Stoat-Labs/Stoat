<!-- Railway's project card: a name and a star over a miniature canvas of the project's resources. -->
<script lang="ts" module>
    export type ProjectCardResource = {
        id: string;
        name: string;
        icon: string | null;
        type: string | null;
        image: string | null;
        status:
            | "queued"
            | "running"
            | "ready"
            | "failed"
            | "cancelled"
            | null;
    };

    /** Stand-in tiles for the loading skeleton. */
    export const placeholderResources: ProjectCardResource[] = [
        "a",
        "b",
        "c",
        "d",
        "e",
    ].map((id) => ({
        id,
        name: "Resource",
        icon: null,
        type: null,
        image: null,
        status: null,
    }));

    /** How many resources are deployed, and the dot for the most urgent state, as on Railway. */
    export function projectStatus(resources: ProjectCardResource[]) {
        const deployed = resources.filter(
            (resource) => resource.status === "ready",
        ).length;

        const dot = resources.some(
            (resource) => resource.status === "failed",
        )
            ? "bg-destructive"
            : resources.some(
                    (resource) =>
                        resource.status === "running" ||
                        resource.status === "queued",
                )
              ? "animate-pulse bg-warning"
              : resources.length > 0 && deployed === resources.length
                ? "bg-success"
                : "bg-muted-foreground/50";

        return { deployed, dot };
    }
</script>

<script lang="ts">
    import {
        Frame,
        FrameHeader,
        FramePanel,
    } from "$lib/components/ui/frame";
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
        /** Omitted while loading, where the star is only a placeholder. */
        onfavorite?: (favorite: boolean) => void;
    } = $props();

    // Two rows of four, like Railway's preview; the rest are counted.
    const MAX_TILES = 8;

    const tiles = $derived(
        resources.length > MAX_TILES
            ? resources.slice(0, MAX_TILES - 1)
            : resources,
    );

    const hidden = $derived(resources.length - tiles.length);

    const { deployed, dot } = $derived(projectStatus(resources));
</script>

<Frame class="group h-full min-w-0">
    <FrameHeader
        class="flex-row items-center justify-between gap-2 py-2 ps-4 pe-2"
    >
        <h3 class="min-w-0 truncate text-[15px] font-semibold">
            {#if href}
                <a
                    {href}
                    class="before:absolute before:inset-0 before:z-10 before:rounded-2xl focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring"
                >
                    {name}
                </a>
            {:else}
                {name}
            {/if}
        </h3>
        <ProjectStar {name} {favorite} {onfavorite} />
    </FrameHeader>

    <!-- The frame panel is the miniature canvas: the same dot grid, resource tiles, then the status line. -->
    <FramePanel
        class="flex h-52 flex-col bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-size-[12px_12px] p-0 transition-colors group-hover:border-input"
    >
        <div
            class="flex min-h-0 flex-1 items-center justify-center p-4"
        >
            {#if resources.length > 0}
                <ul
                    class="grid grid-cols-4 gap-3"
                    aria-label="Resources"
                >
                    {#each tiles as resource (resource.id)}
                        <ResourceTile {resource} />
                    {/each}
                    {#if hidden > 0}
                        <li
                            class="flex size-10 items-center justify-center rounded-lg border bg-card text-xs font-medium text-muted-foreground tabular-nums"
                        >
                            +{hidden}
                        </li>
                    {/if}
                </ul>
            {/if}
        </div>
        <p
            class="flex min-w-0 items-center gap-2 px-3 pb-3 text-xs text-muted-foreground"
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
                    {deployed}/{resources.length} deployed
                {/if}
            </span>
        </p>
    </FramePanel>
</Frame>
