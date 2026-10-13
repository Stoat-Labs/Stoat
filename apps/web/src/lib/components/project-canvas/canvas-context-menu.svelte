<script lang="ts" module>
    /** What was right-clicked: empty canvas, or a resource or service card. */
    export type MenuTarget =
        | { kind: "pane" }
        | { kind: "node"; nodeId: string };

    export type PanelTab =
        | "deployments"
        | "variables"
        | "metrics"
        | "logs"
        | "settings";
</script>

<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import {
        ContextMenu,
        ContextMenuGroup,
        ContextMenuGroupLabel,
        ContextMenuItem,
        ContextMenuLinkItem,
        ContextMenuPopup,
        ContextMenuSeparator,
        ContextMenuTrigger,
    } from "$lib/components/ui/context-menu";
    import ChartColumn from "@lucide/svelte/icons/chart-column";
    import Database from "@lucide/svelte/icons/database";
    import ExternalLink from "@lucide/svelte/icons/external-link";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Layers from "@lucide/svelte/icons/layers";
    import ScrollText from "@lucide/svelte/icons/scroll-text";
    import Settings from "@lucide/svelte/icons/settings";
    import SquareTerminal from "@lucide/svelte/icons/square-terminal";
    import Braces from "@lucide/svelte/icons/braces";
    import Zap from "@lucide/svelte/icons/zap";
    import type { Snippet } from "svelte";
    import type { AddPage } from "./add-palette.svelte";

    let {
        projectId,
        target,
        children,
        onaddpage,
        onopen,
    }: {
        projectId: string;
        /** Set by the canvas' own context-menu handlers just before this menu opens. */
        target: MenuTarget | undefined;
        children: Snippet;
        onaddpage: (page: AddPage) => void;
        onopen: (nodeId: string, tab: PanelTab) => void;
    } = $props();

    const create = $derived(`/projects/${projectId}/create`);

    const resourceId = $derived(
        target?.kind === "node"
            ? target.nodeId.split(":")[0]
            : undefined,
    );

    const views: {
        tab: PanelTab;
        label: string;
        icon: typeof Zap;
    }[] = [
        { tab: "deployments", label: "Latest deploy", icon: Zap },
        { tab: "variables", label: "View Variables", icon: Braces },
        { tab: "metrics", label: "View Metrics", icon: ChartColumn },
        { tab: "logs", label: "View Logs", icon: ScrollText },
        { tab: "settings", label: "View Settings", icon: Settings },
    ];
</script>

<ContextMenu>
    <ContextMenuTrigger class="size-full">
        {@render children()}
    </ContextMenuTrigger>
    <ContextMenuPopup class="min-w-56">
        {#if target?.kind === "node"}
            {#each views as view (view.tab)}
                <ContextMenuItem
                    onclick={() => {
                        if (target?.kind === "node")
                            onopen(target.nodeId, view.tab);
                    }}
                >
                    <view.icon aria-hidden="true" />
                    {view.label}
                </ContextMenuItem>
            {/each}
            <ContextMenuSeparator />
            <ContextMenuLinkItem
                href="/projects/{projectId}/{resourceId}"
            >
                <ExternalLink aria-hidden="true" />
                Open resource page
            </ContextMenuLinkItem>
        {:else}
            <!-- Railway's canvas menu: the same choices as + Add. -->
            <ContextMenuGroup>
                <ContextMenuGroupLabel>
                    Add New Service
                </ContextMenuGroupLabel>
                <ContextMenuItem
                    onclick={() => void goto(`${create}/git`)}
                >
                    <GitBranch aria-hidden="true" />
                    Git Repository
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => onaddpage("template")}
                >
                    <Layers aria-hidden="true" />
                    Template
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => onaddpage("database")}
                >
                    <Database aria-hidden="true" />
                    Database
                </ContextMenuItem>
                {#if page.data.isOrganizationAdmin}
                    <ContextMenuItem
                        onclick={() => void goto(`${create}/bucket`)}
                    >
                        <HardDrive aria-hidden="true" />
                        Bucket
                    </ContextMenuItem>
                {/if}
                <ContextMenuItem
                    onclick={() => void goto(`${create}/compose`)}
                >
                    <SquareTerminal aria-hidden="true" />
                    Empty Compose
                </ContextMenuItem>
            </ContextMenuGroup>
        {/if}
    </ContextMenuPopup>
</ContextMenu>
