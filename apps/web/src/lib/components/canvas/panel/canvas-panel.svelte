<script lang="ts">
    import DeploymentViewer from "$lib/components/deployments/deployment-viewer.svelte";
    import ResourceLogs from "$lib/components/projects/resource-logs.svelte";
    import ResourceMetricsView from "$lib/components/projects/resource-metrics-view.svelte";
    import ResourceSettingsView from "$lib/components/projects/resource-settings-view.svelte";
    import ResourceVariablesView from "$lib/components/projects/resource-variables-view.svelte";
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
    import { cubicOut } from "svelte/easing";
    import { prefersReducedMotion } from "svelte/motion";
    import { fly } from "svelte/transition";
    import type { CanvasResource, CanvasService } from "../graph";
    import CanvasDeployments from "./canvas-deployments.svelte";
    import CanvasSettings from "./canvas-settings.svelte";
    import CanvasVariables from "./canvas-variables.svelte";

    let {
        clusterId,
        resource,
        services,
        selectedService,
        icon,
        changed,
        width,
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
        onclose: () => void;
    } = $props();

    const tabs = [
        "deployments",
        "variables",
        "metrics",
        "logs",
        "settings",
    ] as const;

    const labels: Record<(typeof tabs)[number], string> = {
        deployments: "Deployments",
        variables: "Variables",
        metrics: "Metrics",
        logs: "Logs",
        settings: "Settings",
    };

    const isBucket = $derived(resource.type === "bucket");

    // Buckets have no deployments, containers or logs of their own.
    const visibleTabs = $derived(
        isBucket ? (["variables", "settings"] as const) : tabs,
    );

    const urlOptions = { shallow: true, scroll: false } as const;

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
        active === "logs" || (active === "settings" && !isBucket),
    );

    const slide = $derived({
        x: 48,
        duration: prefersReducedMotion.current ? 0 : 240,
        easing: cubicOut,
    });
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
    class="absolute top-6 right-0 bottom-0 z-10 flex flex-col overflow-hidden rounded-tl-xl border-t border-l border-border bg-card shadow-md/10"
    style:width="{width}px"
    aria-label="{resource.name} details"
    transition:fly={slide}
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
    <!-- Settings and logs run edge to edge, like Railway's; the other tabs sit inside the panel's gutter. -->
    <div
        class={[
            "min-h-0 flex-1 overflow-y-auto",
            !fullBleed && "px-12 pt-8 pb-12",
        ]}
        role="tabpanel"
    >
        {#if active === "deployments"}
            <CanvasDeployments
                {clusterId}
                {resource}
                {services}
                {selectedService}
                {icon}
                {changed}
            />
        {:else if active === "variables" && isBucket}
            <ResourceVariablesView
                projectId={resource.projectId}
                resourceId={resource.id}
            />
        {:else if active === "variables"}
            <CanvasVariables {resource} />
        {:else if active === "metrics"}
            <ResourceMetricsView
                projectId={resource.projectId}
                resourceId={resource.id}
                embedded
            />
        {:else if active === "logs"}
            <ResourceLogs
                projectId={resource.projectId}
                resourceId={resource.id}
                embedded
            />
        {:else if isBucket}
            <div class="px-12 pt-8 pb-12">
                <ResourceSettingsView
                    projectId={resource.projectId}
                    resourceId={resource.id}
                />
            </div>
        {:else}
            <CanvasSettings {resource} {services} />
        {/if}
    </div>
</aside>

{#if deployment.current}
    <!-- Stacked over the resource panel, offset so the panel beneath stays visible, like Railway. -->
    <aside
        class="absolute top-12 right-0 bottom-0 z-20 flex flex-col overflow-hidden rounded-tl-xl border-t border-l border-border bg-card shadow-xl/15"
        style:width="{width}px"
        aria-label="Deployment logs"
        transition:fly={slide}
    >
        <header class="flex items-center gap-4 px-12 pt-12 pb-6">
            {@render resourceIcon()}
            <h2
                class="min-w-0 flex-1 truncate text-2xl font-semibold"
            >
                {resource.name}
                <span
                    class="font-mono text-lg font-normal text-muted-foreground"
                >
                    / {deployment.current.slice(0, 8)}
                </span>
            </h2>
            <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Close deployment logs"
                onclick={() => void deployment.set(null)}
            >
                <X class="size-4" aria-hidden="true" />
            </Button>
        </header>
        <div class="min-h-0 flex-1 px-12 pb-12">
            {#key deployment.current}
                <DeploymentViewer
                    deploymentId={deployment.current}
                    backHref="/projects/{resource.projectId}/canvas?node={resource.id}"
                    embedded
                />
            {/key}
        </div>
    </aside>
{/if}
