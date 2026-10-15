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
        ContextMenuCheckboxItem,
        ContextMenuGroup,
        ContextMenuGroupLabel,
        ContextMenuItem,
        ContextMenuLinkItem,
        ContextMenuPopup,
        ContextMenuSeparator,
        ContextMenuSub,
        ContextMenuSubPopup,
        ContextMenuSubTrigger,
        ContextMenuTrigger,
    } from "$lib/components/ui/context-menu";
    import Group from "@lucide/svelte/icons/group";
    import Plus from "@lucide/svelte/icons/plus";
    import Ungroup from "@lucide/svelte/icons/ungroup";
    import ChartColumn from "@lucide/svelte/icons/chart-column";
    import Container from "@lucide/svelte/icons/container";
    import Copy from "@lucide/svelte/icons/copy";
    import FolderInput from "@lucide/svelte/icons/folder-input";
    import Database from "@lucide/svelte/icons/database";
    import ExternalLink from "@lucide/svelte/icons/external-link";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Layers from "@lucide/svelte/icons/layers";
    import RotateCw from "@lucide/svelte/icons/rotate-cw";
    import ScrollText from "@lucide/svelte/icons/scroll-text";
    import Settings from "@lucide/svelte/icons/settings";
    import SquareTerminal from "@lucide/svelte/icons/square-terminal";
    import Braces from "@lucide/svelte/icons/braces";
    import Zap from "@lucide/svelte/icons/zap";
    import type { Snippet } from "svelte";
    import type { AddPage } from "./add-palette.svelte";
    import { getCanvasActions } from "../context";
    import Trash2 from "@lucide/svelte/icons/trash-2";

    let {
        projectId,
        target,
        groups,
        children,
        onaddpage,
        onopen,
    }: {
        projectId: string;
        /** Set by the canvas' own context-menu handlers just before this menu opens. */
        target: MenuTarget | undefined;
        /** Resources drawn as frames, Railway's groups: their right-click gets the group actions. */
        groups: { id: string; name: string }[];
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

    const actions = getCanvasActions();

    // A frame or a lone card stands for the whole resource; a card in a frame is one service.
    const wholeResource = $derived(
        target?.kind === "node" && !target.nodeId.includes(":"),
    );

    const isFrame = $derived(
        wholeResource &&
            groups.some((group) => group.id === resourceId),
    );

    // A service card, in a frame or alone: Railway's "Group ›" moves it between groups.
    const isCard = $derived(target?.kind === "node" && !isFrame);

    const inGroup = $derived(
        target?.kind === "node" && target.nodeId.includes(":"),
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
            {#if isCard && target.kind === "node"}
                {@const nodeId = target.nodeId}
                <!-- Railway's service menu starts with its group: start a new one, or tick another. -->
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Group aria-hidden="true" />
                        Group
                    </ContextMenuSubTrigger>
                    <ContextMenuSubPopup class="min-w-52">
                        <ContextMenuItem
                            disabled={!inGroup}
                            onclick={() =>
                                actions.regroup(nodeId, null)}
                        >
                            <Plus aria-hidden="true" />
                            New Group
                        </ContextMenuItem>
                        {#if groups.length}
                            <ContextMenuSeparator />
                        {/if}
                        {#each groups as group (group.id)}
                            <!-- Picking a group acts at once, like Railway, so the menu closes. -->
                            <ContextMenuCheckboxItem
                                closeOnClick
                                checked={group.id === resourceId}
                                onCheckedChange={() =>
                                    actions.regroup(
                                        nodeId,
                                        group.id === resourceId
                                            ? null
                                            : group.id,
                                    )}
                            >
                                {group.name}
                            </ContextMenuCheckboxItem>
                        {/each}
                    </ContextMenuSubPopup>
                </ContextMenuSub>
                <ContextMenuSeparator />
            {/if}
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
            {#if page.data.isOrganizationAdmin && resourceId}
                {@const id = resourceId}
                <ContextMenuSeparator />
                <!-- Staged edits ship through the apply bar instead. -->
                <ContextMenuItem
                    disabled={!actions.canRedeploy(id)}
                    onclick={() => actions.redeploy(id)}
                >
                    <RotateCw aria-hidden="true" />
                    Redeploy
                </ContextMenuItem>
            {/if}
            {#if isFrame && resourceId}
                {@const id = resourceId}
                <ContextMenuSeparator />
                <!-- Railway's group actions, on the frame's own right-click too. -->
                <ContextMenuItem
                    onclick={() => actions.edit("rename", id)}
                >
                    Rename
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => actions.edit("icon-upload", id)}
                >
                    Upload icon
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => actions.edit("icon-link", id)}
                >
                    Icon from link
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => actions.toggleCollapsed(id)}
                >
                    {actions.isCollapsed(id)
                        ? "Show contents"
                        : "Hide contents"}
                </ContextMenuItem>
                <ContextMenuItem onclick={() => actions.ungroup(id)}>
                    <Ungroup aria-hidden="true" />
                    Remove Group
                </ContextMenuItem>
            {/if}
            {#if wholeResource && resourceId}
                {@const id = resourceId}
                <ContextMenuSeparator />
                <ContextMenuItem
                    onclick={() => actions.edit("move", id)}
                >
                    <FolderInput aria-hidden="true" />
                    Move to Project…
                </ContextMenuItem>
                <ContextMenuItem
                    onclick={() => actions.edit("copy", id)}
                >
                    <Copy aria-hidden="true" />
                    Copy to Project…
                </ContextMenuItem>
            {/if}
            <ContextMenuSeparator />
            <ContextMenuLinkItem
                href="/projects/{projectId}/{resourceId}"
            >
                <ExternalLink aria-hidden="true" />
                Open resource page
            </ContextMenuLinkItem>
            {#if wholeResource && resourceId}
                {@const id = resourceId}
                <ContextMenuSeparator />
                <ContextMenuItem
                    variant="destructive"
                    onclick={() => actions.remove(id)}
                >
                    <Trash2 aria-hidden="true" />
                    Delete resource
                </ContextMenuItem>
            {/if}
        {:else}
            <!-- Railway's canvas menu: the same choices as + Add. -->
            <ContextMenuGroup>
                <ContextMenuGroupLabel>
                    Add New Service
                </ContextMenuGroupLabel>
                <ContextMenuItem onclick={() => onaddpage("git")}>
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
                <ContextMenuItem onclick={() => onaddpage("docker")}>
                    <Container aria-hidden="true" />
                    Docker Image
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
