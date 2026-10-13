<script lang="ts">
    import { isActiveDeploymentStatus } from "$lib/deployments/status";
    import { ago } from "$lib/format";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import CircleX from "@lucide/svelte/icons/circle-x";
    import LoaderCircle from "@lucide/svelte/icons/loader-circle";
    import { getCanvasClock } from "./context";
    import type { CanvasResource } from "./graph";

    let {
        resource,
        draftOnly,
    }: { resource: CanvasResource; draftOnly: boolean } = $props();

    // Railway says "Just deployed" for a few minutes, then settles on "Online".
    const JUST_DEPLOYED_MS = 10 * 60_000;

    const clock = getCanvasClock();

    const status = $derived(resource.deploymentStatus);

    const finishedAt = $derived(
        resource.deploymentFinishedAt ?? resource.deploymentCreatedAt,
    );

    const via = $derived(resource.gitBranch ? " via Git" : "");

    const state = $derived.by(() => {
        if (resource.bucketStatus) return "bucket";

        if (!status || status === "cancelled") return "offline";

        if (isActiveDeploymentStatus(status)) return "deploying";

        if (status === "failed") return "failed";

        return finishedAt &&
            clock.now - new Date(finishedAt).getTime() <
                JUST_DEPLOYED_MS
            ? "deployed"
            : "online";
    });
</script>

{#if state === "bucket"}
    <!-- Railway's bucket card: plain grey text, no icon. -->
    <p class="truncate text-sm text-muted-foreground capitalize">
        {resource.bucketStatus}
    </p>
{:else if state === "offline"}
    <p class="truncate text-sm text-muted-foreground">
        {draftOnly ? "Draft, not deployed" : "Service is offline"}
    </p>
{:else}
    <!-- Railway's status row: icon in a 24px column, 12px gap, 14px text. -->
    <span
        class="grid min-w-0 grid-cols-[24px_1fr] items-center gap-3 text-sm"
    >
        {#if state === "online"}
            <svg
                class="size-4 text-success"
                viewBox="0 0 16 16"
                aria-hidden="true"
            >
                <circle cx="8" cy="8" r="3" fill="currentColor" />
            </svg>
            <span class="truncate text-success-foreground">
                Online
            </span>
        {:else if state === "deployed"}
            <CircleCheck
                class="size-4 text-success-foreground"
                aria-hidden="true"
            />
            <span class="truncate text-muted-foreground">
                Just deployed{via}
            </span>
        {:else if state === "deploying"}
            <LoaderCircle
                class="size-4 animate-spin text-warning-foreground motion-reduce:animate-none"
                aria-hidden="true"
            />
            <span class="truncate text-warning-foreground">
                {status === "queued" ? "Queued" : "Deploying"}
            </span>
        {:else}
            <CircleX
                class="size-4 text-destructive-foreground"
                aria-hidden="true"
            />
            <span class="truncate text-destructive-foreground">
                Failed {finishedAt ? ago(finishedAt, clock.now) : ""}
            </span>
        {/if}
    </span>
{/if}
