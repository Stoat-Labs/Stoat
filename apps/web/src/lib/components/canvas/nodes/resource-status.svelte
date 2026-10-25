<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import { isActiveDeploymentStatus } from "$lib/deployments/status";
    import { ago } from "$lib/format";
    import { containerInfo } from "$lib/resources/container-info";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import CircleX from "@lucide/svelte/icons/circle-x";
    import LoaderCircle from "@lucide/svelte/icons/loader-circle";
    import { createQuery } from "@tanstack/svelte-query";
    import { getCanvasClock, getCanvasCluster } from "../context";
    import type { CanvasResource } from "../graph";

    let {
        resource,
        draftOnly,
    }: { resource: CanvasResource; draftOnly: boolean } = $props();

    // Railway says "Just deployed" for a few minutes, then settles on "Online".
    const JUST_DEPLOYED_MS = 10 * 60_000;

    const clock = getCanvasClock();

    const status = $derived(resource.deploymentStatus);

    const cluster = getCanvasCluster();

    // A finished deploy only says the rollout worked; the containers say whether it still runs.
    // Same query as the deployments panel, so opening the panel reuses this cache.
    const containersQuery = createQuery(() =>
        orpc.resources.getContainers.queryOptions({
            input: {
                clusterId: cluster.id,
                projectId: resource.projectId,
                resourceId: resource.id,
            },
            enabled:
                cluster.id.length > 0 &&
                status === "ready" &&
                !resource.bucketStatus,
            refetchInterval: 30_000,
        }),
    );

    const unhealthy = $derived(
        containersQuery.data?.some(({ container }) => {
            const info = containerInfo(container);

            return (
                info.health === "unhealthy" ||
                info.status === "exited"
            );
        }) ?? false,
    );

    const finishedAt = $derived(
        resource.deploymentFinishedAt ?? resource.deploymentCreatedAt,
    );

    const sources = {
        forgejo: "Forgejo",
        github: "GitHub",
        git: "Git",
        docker: "",
    };

    // Deployments from before metadata existed fall back to the resource's current source.
    const via = $derived.by(() => {
        const source =
            resource.deploymentSource ??
            (resource.gitBranch ? "git" : "docker");

        return sources[source] ? ` via ${sources[source]}` : "";
    });

    const state = $derived.by(() => {
        if (resource.bucketStatus) return "bucket";

        if (!status) return "offline";

        // A cancelled deploy may never have started, so it says nothing about the running service.
        if (status === "cancelled") return "cancelled";

        if (isActiveDeploymentStatus(status)) return "deploying";

        if (status === "failed") return "failed";

        if (unhealthy) return "unhealthy";

        return finishedAt &&
            clock.now - new Date(finishedAt).getTime() <
                JUST_DEPLOYED_MS
            ? "deployed"
            : "online";
    });
</script>

{#if state === "bucket"}
    <!-- Railway's bucket card: plain grey text, with a braille spinner while a job runs. -->
    <p
        class="flex items-center gap-2 truncate text-sm text-muted-foreground capitalize"
    >
        {#if resource.bucketStatus === "provisioning" || resource.bucketStatus === "deleting"}
            <span
                class="spinner w-3 shrink-0"
                aria-hidden="true"
            ></span>
        {/if}
        {resource.bucketStatus}
    </p>
{:else if state === "offline"}
    <p class="truncate text-sm text-muted-foreground">
        {draftOnly ? "Draft, not deployed" : "Service is offline"}
    </p>
{:else if state === "cancelled"}
    <p class="truncate text-sm text-muted-foreground">
        Deploy cancelled {finishedAt
            ? ago(finishedAt, clock.now)
            : ""}
    </p>
{:else}
    <!-- Status row: icon in a 24px column, 12px gap, 14px text. -->
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
                {state === "unhealthy"
                    ? "Unhealthy"
                    : `Failed ${finishedAt ? ago(finishedAt, clock.now) : ""}`}
            </span>
        {/if}
    </span>
{/if}

<style>
    .spinner::before {
        content: "⠋";
        animation: braille 0.8s steps(1) infinite;
    }

    @keyframes braille {
        10% {
            content: "⠙";
        }
        20% {
            content: "⠹";
        }
        30% {
            content: "⠸";
        }
        40% {
            content: "⠼";
        }
        50% {
            content: "⠴";
        }
        60% {
            content: "⠦";
        }
        70% {
            content: "⠧";
        }
        80% {
            content: "⠇";
        }
        90% {
            content: "⠏";
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .spinner::before {
            animation: none;
        }
    }
</style>
