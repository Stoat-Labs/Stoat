<script lang="ts">
    import { page } from "$app/state";
    import CanvasDeploymentLogs from "./canvas-deployment-logs.svelte";
    import CanvasResourceLogs from "./canvas-resource-logs.svelte";
    import ResourceMetricsView from "$lib/components/projects/resource-metrics-view.svelte";
    import BucketFiles from "$lib/components/s3/bucket-files.svelte";
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import { Button } from "$lib/components/ui/button";
    import Box from "@lucide/svelte/icons/box";
    import ExternalLink from "@lucide/svelte/icons/external-link";
    import X from "@lucide/svelte/icons/x";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";
    import { cubicOut, expoOut } from "svelte/easing";
    import { prefersReducedMotion } from "svelte/motion";
    import { fly } from "svelte/transition";
    import type { CanvasResource, CanvasService } from "../graph";
    import CanvasCompose from "./canvas-compose.svelte";
    import CanvasDeployments from "./canvas-deployments.svelte";
    import CanvasSettings from "./canvas-settings.svelte";
    import CanvasBucketVariables from "./canvas-bucket-variables.svelte";
    import CanvasVariables from "./canvas-variables.svelte";

    let {
        clusterId,
        resource,
        services,
        selectedService,
        icon,
        changed,
        width,
        inset,
        onclose,
    }: {
        clusterId: string;
        resource: CanvasResource;
        services: CanvasService[];
        selectedService: string | undefined;
        icon: string | null;
        /** Whether the resource has staged edits that are not deployed yet. */
        changed: boolean;
        /** Pixel width, shared with the canvas so it can keep the opened node in view. */
        width: number;
        /** Narrow canvases hide the graph: the panel floats over all of it, inset from the sides. */
        inset: boolean;
        onclose: () => void;
    } = $props();

    const tabs = [
        "files",
        "deployments",
        "variables",
        "compose",
        "metrics",
        "logs",
        "settings",
    ] as const;

    const labels: Record<(typeof tabs)[number], string> = {
        files: "Files",
        deployments: "Deployments",
        variables: "Variables",
        compose: "Compose",
        metrics: "Metrics",
        logs: "Logs",
        settings: "Settings",
    };

    const isBucket = $derived(resource.type === "bucket");

    // Buckets have no deployments, containers or logs of their own; only buckets hold files.
    const visibleTabs = $derived(
        isBucket
            ? (["files", "variables", "settings"] as const)
            : tabs.filter((name) => name !== "files"),
    );

    // Matches project-canvas, so Back steps through tabs and stacked logs.
    const urlOptions = {
        history: "push",
        shallow: true,
        scroll: false,
    } as const;

    const tab = useQueryState(
        "tab",
        parseAsStringLiteral(tabs).withOptions(urlOptions),
    );

    // The deployment whose logs are stacked on top of this panel.
    const deployment = useQueryState(
        "deployment",
        parseAsString.withOptions(urlOptions),
    );

    const active = $derived(
        tab.current &&
            visibleTabs.some((name) => name === tab.current)
            ? tab.current
            : visibleTabs[0],
    );

    const fullBleed = $derived(
        active === "logs" ||
            active === "files" ||
            active === "settings" ||
            active === "compose",
    );

    // Railway: the panel travels a fifth of its width while fading, settling slowly on open and leaving faster.
    const enter = $derived({
        x: width * 0.2,
        duration: prefersReducedMotion.current ? 0 : 400,
        easing: expoOut,
    });

    const leave = $derived({
        x: width * 0.2,
        duration: prefersReducedMotion.current ? 0 : 250,
        easing: cubicOut,
    });

    const stacked = $derived(Boolean(deployment.current));

    const edge = $derived(
        inset
            ? "right-5 rounded-t-xl border"
            : "right-0 rounded-tl-xl border-t border-l",
    );
</script>

{#snippet resourceIcon()}
    {#if icon}
        <img
            src={icon}
            alt=""
            aria-hidden="true"
            class="size-8 shrink-0 object-contain"
        />
    {:else if isBucket}
        <BucketIcon class="size-8 shrink-0" aria-hidden="true" />
    {:else}
        <Box
            class="size-8 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
        />
    {/if}
{/snippet}

<!-- Railway's panel: flush right and bottom, 24px below the canvas top, only the top-left corner rounded. -->
<aside
    class={[
        "absolute bottom-0 z-10 flex flex-col overflow-hidden border-border bg-card shadow-md/10 transition-[top] duration-300",
        stacked ? "top-12" : "top-6",
        edge,
    ]}
    style:width="{width}px"
    aria-label="{resource.name} details"
    in:fly|global={enter}
    out:fly|global={leave}
>
    <header class="flex items-center gap-4 px-12 pt-12 pb-6">
        {@render resourceIcon()}
        <h2 class="min-w-0 flex-1 truncate text-2xl font-semibold">
            {resource.name}
            {#if selectedService}
                <span class="font-normal text-muted-foreground">
                    / {selectedService}
                </span>
            {/if}
        </h2>
        <Button
            size="icon-sm"
            variant="ghost"
            href="/projects/{resource.projectId}/{resource.id}"
            aria-label="Open resource page"
        >
            <ExternalLink class="size-4" aria-hidden="true" />
        </Button>
        <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close details"
            onclick={onclose}
        >
            <X class="size-4" aria-hidden="true" />
        </Button>
    </header>

    <!-- Railway's tabs: 16px labels 32px apart, a 1px underline on the active one. -->
    <div
        class="flex shrink-0 gap-8 overflow-x-auto border-b border-border px-12"
        role="tablist"
        aria-label="{resource.name} sections"
    >
        {#each visibleTabs as name (name)}
            <button
                type="button"
                role="tab"
                aria-selected={active === name}
                class={[
                    "relative shrink-0 pb-3 text-base transition-colors",
                    active === name
                        ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground"
                        : "text-muted-foreground hover:text-foreground",
                ]}
                onclick={() => void tab.set(name)}
            >
                {labels[name]}
            </button>
        {/each}
    </div>

    <!-- Each tab mounts only while visible; logs and metrics hold live sessions. -->
    <!-- Settings, logs and files run edge to edge, like Railway's; the other tabs sit inside the panel's gutter. -->
    <div
        class={[
            "min-h-0 flex-1",
            active === "logs" ||
            active === "files" ||
            active === "compose"
                ? "overflow-hidden"
                : "overflow-y-auto",
            !fullBleed && "px-12 pt-8 pb-12",
        ]}
        role="tabpanel"
    >
        {#if active === "files"}
            <BucketFiles
                projectId={resource.projectId}
                resourceId={resource.id}
            />
        {:else if active === "deployments"}
            <CanvasDeployments
                {clusterId}
                {resource}
                {services}
                {selectedService}
                {icon}
                {changed}
            />
        {:else if active === "variables" && isBucket}
            <CanvasBucketVariables {resource} />
        {:else if active === "variables"}
            <CanvasVariables {resource} />
        {:else if active === "compose"}
            <CanvasCompose {resource} />
        {:else if active === "metrics"}
            <ResourceMetricsView
                projectId={resource.projectId}
                resourceId={resource.id}
                embedded
            />
        {:else if active === "logs"}
            <CanvasResourceLogs
                projectId={resource.projectId}
                resourceId={resource.id}
                serviceName={selectedService}
                focused={!stacked}
            />
        {:else}
            <CanvasSettings {resource} {services} />
        {/if}
    </div>
</aside>

{#if deployment.current}
    <!-- Sits higher and 24px narrower than the resource panel, which drops down behind it so its left and top edges stay visible, like Railway. -->
    <aside
        class="absolute top-6 bottom-0 z-20 flex flex-col overflow-hidden border-border bg-card shadow-xl/15 {edge}"
        style:width="{width - 24}px"
        aria-label="Deployment logs"
        in:fly|global={enter}
        out:fly|global={leave}
    >
        {#key deployment.current}
            <CanvasDeploymentLogs
                deploymentId={deployment.current}
                name={resource.name}
                {icon}
                redeploy={page.data.isOrganizationAdmin === true &&
                !changed
                    ? {
                          projectId: resource.projectId,
                          resourceId: resource.id,
                      }
                    : undefined}
                onclose={() => void deployment.set(null)}
                onopen={(id) => void deployment.set(id)}
            />
        {/key}
    </aside>
{/if}
