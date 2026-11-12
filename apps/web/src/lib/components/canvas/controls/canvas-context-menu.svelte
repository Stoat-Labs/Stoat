<script lang="ts" module>
    /** What was right-clicked: empty canvas, a group's frame, or a card. */
    export type MenuTarget =
        | { kind: "pane" }
        | { kind: "group"; groupId: string }
        | {
              kind: "node";
              nodeId: string;
              /** The group whose frame the card sits in. */
              groupId: string | undefined;
              /** How many Compose services the card's resource has. */
              services: number;
          };

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
    import ArrowRightLeft from "phosphor-svelte/lib/ArrowsLeftRightIcon";
    import Group from "phosphor-svelte/lib/BoundingBoxIcon";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import Ungroup from "phosphor-svelte/lib/SelectionIcon";
    import ChartColumn from "phosphor-svelte/lib/ChartBarIcon";
    import Container from "phosphor-svelte/lib/ShippingContainerIcon";
    import Copy from "phosphor-svelte/lib/CopyIcon";
    import CopyPlus from "phosphor-svelte/lib/CopySimpleIcon";
    import FolderInput from "phosphor-svelte/lib/FolderPlusIcon";
    import Database from "phosphor-svelte/lib/DatabaseIcon";
    import ExternalLink from "phosphor-svelte/lib/ArrowSquareOutIcon";
    import GitBranch from "phosphor-svelte/lib/GitBranchIcon";
    import FileCog from "$lib/components/shared/file-gear-icon.svelte";
    import HardDrive from "$lib/components/shared/hard-drive-icon.svelte";
    import Layers from "phosphor-svelte/lib/StackIcon";
    import Play from "phosphor-svelte/lib/PlayIcon";
    import RotateCw from "phosphor-svelte/lib/ArrowClockwiseIcon";
    import Square from "phosphor-svelte/lib/SquareIcon";
    import ScrollText from "phosphor-svelte/lib/ScrollIcon";
    import Settings from "phosphor-svelte/lib/GearSixIcon";
    import SquareTerminal from "phosphor-svelte/lib/TerminalWindowIcon";
    import Braces from "phosphor-svelte/lib/BracketsCurlyIcon";
    import Zap from "phosphor-svelte/lib/LightningIcon";
    import type { Snippet } from "svelte";
    import type { AddPage } from "./add-palette.svelte";
    import { getCanvasActions } from "../context";
    import { parseNodeId } from "../graph";
    import Trash2 from "phosphor-svelte/lib/TrashIcon";
    import Undo2 from "phosphor-svelte/lib/ArrowUUpLeftIcon";

    let {
        projectId,
        target,
        groups,
        canAdd,
        canAddVolume,
        children,
        onaddpage,
        onopen,
    }: {
        projectId: string;
        /** Set by the canvas' own context-menu handlers just before this menu opens. */
        target: MenuTarget | undefined;
        /** The project's groups, listed under a card's "Group ›". */
        groups: { id: string; name: string }[];
        /** False on internal projects, which take no new resources. */
        canAdd: boolean;
        /** Whether any service can take a volume or config. */
        canAddVolume: boolean;
        children: Snippet;
        onaddpage: (page: AddPage) => void;
        onopen: (nodeId: string, tab: PanelTab) => void;
    } = $props();

    const create = $derived(`/projects/${projectId}/create`);

    const resourceId = $derived(
        target?.kind === "node"
            ? parseNodeId(target.nodeId).resourceId
            : undefined,
    );

    const actions = getCanvasActions();

    const configNodeId = $derived(
        target?.kind === "node" && target.nodeId.includes("#")
            ? target.nodeId
            : undefined,
    );

    // A volume no service mounts is a card of its own; it has no deployments, logs or settings.
    const volumeNodeId = $derived(
        target?.kind === "node" && target.nodeId.includes("/")
            ? target.nodeId
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
        {#if configNodeId}
            {@const nodeId = configNodeId}
            {#if actions.isConfigMounted(nodeId)}
                <ContextMenuItem
                    onclick={() => actions.disconnectConfig(nodeId)}
                >
                    <FileCog aria-hidden="true" />
                    Disconnect config
                </ContextMenuItem>
                <ContextMenuSeparator />
            {/if}
            <ContextMenuItem
                onclick={() => onopen(nodeId, "settings")}
            >
                <Settings aria-hidden="true" />
                View Settings
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
                variant="destructive"
                onclick={() => actions.removeConfig(nodeId)}
            >
                <Trash2 aria-hidden="true" />
                Delete config
            </ContextMenuItem>
        {:else if volumeNodeId}
            {@const nodeId = volumeNodeId}
            <!-- Railway's volume menu: disconnect, its two tabs, then delete. -->
            {#if actions.isVolumeMounted(nodeId)}
                <ContextMenuItem
                    onclick={() => actions.disconnectVolume(nodeId)}
                >
                    <HardDrive aria-hidden="true" />
                    Disconnect volume
                </ContextMenuItem>
                <ContextMenuSeparator />
            {/if}
            <ContextMenuItem
                onclick={() => onopen(nodeId, "metrics")}
            >
                <ChartColumn aria-hidden="true" />
                View Metrics
            </ContextMenuItem>
            <ContextMenuItem
                onclick={() => onopen(nodeId, "settings")}
            >
                <Settings aria-hidden="true" />
                View Settings
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
                variant="destructive"
                onclick={() => actions.removeVolume(nodeId)}
            >
                <Trash2 aria-hidden="true" />
                Delete volume
            </ContextMenuItem>
        {:else if target?.kind === "group"}
            {@const id = target.groupId}
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
            <ContextMenuSeparator />
            <ContextMenuItem onclick={() => actions.ungroup(id)}>
                <Ungroup aria-hidden="true" />
                Remove Group
            </ContextMenuItem>
        {:else if target?.kind === "node" && resourceId}
            {@const card = target}
            {@const id = resourceId}
            <!-- Railway's service menu starts with its group: start a new one, or tick another. -->
            <ContextMenuSub>
                <ContextMenuSubTrigger>
                    <Group aria-hidden="true" />
                    Group
                </ContextMenuSubTrigger>
                <ContextMenuSubPopup class="min-w-52">
                    <ContextMenuItem
                        onclick={() => actions.edit("new-group", id)}
                    >
                        <Plus aria-hidden="true" />
                        New Group…
                    </ContextMenuItem>
                    {#if groups.length}
                        <ContextMenuSeparator />
                    {/if}
                    {#each groups as group (group.id)}
                        <!-- Picking a group acts at once, like Railway; its own group takes it out. -->
                        <ContextMenuCheckboxItem
                            closeOnClick
                            checked={group.id === card.groupId}
                            onCheckedChange={() =>
                                actions.setGroup(
                                    id,
                                    group.id === card.groupId
                                        ? null
                                        : group.id,
                                )}
                        >
                            {group.name}
                        </ContextMenuCheckboxItem>
                    {/each}
                </ContextMenuSubPopup>
            </ContextMenuSub>
            {#if card.services > 0}
                <ContextMenuItem
                    onclick={() => actions.edit("move-service", id)}
                >
                    <ArrowRightLeft aria-hidden="true" />
                    Move service…
                </ContextMenuItem>
            {/if}
            <ContextMenuSeparator />
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

            {@const runState = actions.runState(id)}
            <ContextMenuSeparator />
            <!-- Staged edits ship through the apply bar instead. -->
            <ContextMenuItem
                disabled={!actions.canRedeploy(id)}
                onclick={() => actions.redeploy(id)}
            >
                <RotateCw aria-hidden="true" />
                Redeploy
            </ContextMenuItem>
            {#if runState === "stopped"}
                <ContextMenuItem
                    onclick={() => actions.setRunning(id, true)}
                >
                    <Play aria-hidden="true" />
                    Start
                </ContextMenuItem>
            {:else if runState === "running"}
                <ContextMenuItem
                    onclick={() => actions.setRunning(id, false)}
                >
                    <Square aria-hidden="true" />
                    Stop
                </ContextMenuItem>
            {/if}

            <ContextMenuSeparator />
            <ContextMenuItem
                onclick={() => actions.edit("duplicate", id)}
            >
                <CopyPlus aria-hidden="true" />
                Duplicate…
            </ContextMenuItem>
            <ContextMenuItem onclick={() => actions.edit("move", id)}>
                <FolderInput aria-hidden="true" />
                Move to Project…
            </ContextMenuItem>
            <ContextMenuItem onclick={() => actions.edit("copy", id)}>
                <Copy aria-hidden="true" />
                Copy to Project…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuLinkItem
                href="/projects/{projectId}/{resourceId}"
            >
                <ExternalLink aria-hidden="true" />
                Open resource page
            </ContextMenuLinkItem>
            <ContextMenuSeparator />
            {#if actions.isPendingDelete(id)}
                <ContextMenuItem onclick={() => actions.restore(id)}>
                    <Undo2 aria-hidden="true" />
                    Undo delete
                </ContextMenuItem>
            {:else}
                <ContextMenuItem
                    variant="destructive"
                    onclick={() => actions.remove(id)}
                >
                    <Trash2 aria-hidden="true" />
                    Delete resource
                </ContextMenuItem>
            {/if}
        {:else if !canAdd}
            <ContextMenuGroup>
                <ContextMenuGroupLabel>
                    Stoat manages this project's services
                </ContextMenuGroupLabel>
            </ContextMenuGroup>
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
                {#if canAddVolume}
                    <ContextMenuItem
                        onclick={() => onaddpage("volume")}
                    >
                        <HardDrive aria-hidden="true" />
                        Volume
                    </ContextMenuItem>
                    <ContextMenuItem
                        onclick={() => onaddpage("config")}
                    >
                        <FileCog aria-hidden="true" />
                        Config
                    </ContextMenuItem>
                {/if}

                <ContextMenuItem onclick={() => onaddpage("bucket")}>
                    <HardDrive aria-hidden="true" />
                    Bucket
                </ContextMenuItem>

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
