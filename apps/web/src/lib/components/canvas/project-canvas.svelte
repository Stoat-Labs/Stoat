<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { allExited } from "$lib/resources/container-info";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Kbd, KbdGroup } from "$lib/components/ui/kbd";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import {
        ConnectionMode,
        MarkerType,
        Panel,
        SelectionMode,
        SvelteFlow,
        type Edge,
        type NodeTypes,
    } from "@xyflow/svelte";
    import "@xyflow/svelte/dist/style.css";
    import {
        parseAsArrayOf,
        parseAsBoolean,
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
        useQueryStates,
    } from "nuqs-svelte";
    import { onMount, untrack } from "svelte";
    import CanvasApi from "./canvas-api.svelte";
    import CanvasDots from "./canvas-dots.svelte";
    import { CanvasLayout } from "./canvas-layout.svelte";
    import CanvasResourceDialogs from "./canvas-resource-dialogs.svelte";
    import CanvasFocus from "./canvas-focus.svelte";
    import {
        setCanvasActions,
        setCanvasClock,
        setCanvasCluster,
        type GroupAction,
    } from "./context";
    import AddPalette, {
        addPages,
    } from "./controls/add-palette.svelte";
    import ApplyBar from "./controls/apply-bar.svelte";
    import CanvasContextMenu, {
        type MenuTarget,
        type PanelTab,
    } from "./controls/canvas-context-menu.svelte";
    import CanvasControls, {
        edgeLayers,
        type EdgeLayer,
    } from "./controls/canvas-controls.svelte";
    import GroupDialogs from "./controls/group-dialogs.svelte";
    import MoveServiceDialog from "./controls/move-service-dialog.svelte";
    import {
        buildCanvas,
        buildEdges,
        COLUMN_GAP,
        configNodeId,
        frameRect,
        landResourceCards,
        loadCollapsed,
        loadPositions,
        nearestFree,
        nodeRect,
        parseNodeId,
        refitFrames,
        repairOverlaps,
        saveCollapsed,
        serviceNodeId,
        settle,
        slotBelow,
        volumeNodeId,
        volumeTargets,
        type CanvasGraph,
        type CanvasGroup,
        type CanvasLogos,
        type CanvasNode,
        type CanvasResource,
        type Positions,
        type Rect,
        SNAP_GRID,
    } from "./graph";
    import CardNode from "./nodes/card-node.svelte";
    import StackNode from "./nodes/stack-node.svelte";
    import CanvasConfigPanel from "./panel/canvas-config-panel.svelte";
    import CanvasPanel from "./panel/canvas-panel.svelte";
    import CanvasVolumePanel from "./panel/canvas-volume-panel.svelte";
    import { PanelSize } from "./panel/panel-size.svelte";

    let {
        projectId,
        clusterId,
        isInternal,
        resources,
        graph,
        groups,
        logos,
        layout,
    }: {
        projectId: string;
        clusterId: string;
        /** Internal projects are managed by Stoat and take no new resources. */
        isInternal: boolean;
        resources: CanvasResource[];
        graph: CanvasGraph;
        groups: CanvasGroup[];
        logos: CanvasLogos;
        layout: Positions;
    } = $props();

    const nodeTypes: NodeTypes = { card: CardNode, stack: StackNode };

    // Railway opens an empty project on its Add palette instead of an empty canvas.
    const empty = $derived(resources.length === 0);

    // Selection, tab and stacked logs push history, so Back walks through the panels opened.
    const pageOptions = {
        history: "push",
        shallow: true,
        scroll: false,
    } as const;

    // `<resourceId>` or `<resourceId>:<service>`; a shared link reopens the same panel.
    const selected = useQueryState(
        "node",
        parseAsString.withOptions(pageOptions),
    );

    // A link that opens a card lets CanvasFocus place the camera; fitting first would override it.
    const fitOnLoad = untrack(() => selected.current === null);

    // Stacked deployment logs and the open tab belong to the selected node; a new selection drops them.
    const deployment = useQueryState(
        "deployment",
        parseAsString.withOptions(pageOptions),
    );

    // Shared with the palette and the panel through the URL.
    const add = useQueryState(
        "add",
        parseAsStringLiteral(addPages).withOptions({
            shallow: true,
            scroll: false,
        }),
    );

    // Railway's visibility layers; hidden ones live in the URL, so a shared view keeps them.
    const hidden = useQueryState(
        "hide",
        parseAsArrayOf(parseAsStringLiteral(edgeLayers))
            .withDefault([])
            .withOptions({ shallow: true, scroll: false }),
    );

    const tab = useQueryState(
        "tab",
        parseAsString.withOptions(pageOptions),
    );

    // The selected file in a bucket panel, cleared with the rest when another card opens.
    const file = useQueryState(
        "file",
        parseAsString.withOptions(pageOptions),
    );

    // Transient, so plain state: only which menu the next right-click shows.
    let menuTarget = $state<MenuTarget>();

    function openPanel(nodeId: string, panelTab: PanelTab) {
        select(nodeId);
        void tab.set(panelTab);
    }

    // Per-resource panel state (search, filters, expanded rows) belongs to the node it was set on.
    // Only ever cleared here, so the parsers just need the right keys.
    const panelState = useQueryStates(
        {
            details: parseAsBoolean,
            hideHistory: parseAsBoolean,
            settingsFilter: parseAsString,
            variableSearch: parseAsString,
            systemVariables: parseAsBoolean,
            formatted: parseAsBoolean,
            limitDialog: parseAsBoolean,
            paused: parseAsBoolean,
            metricsLayout: parseAsString,
            rangeOpen: parseAsBoolean,
            range: parseAsString,
            from: parseAsString,
            to: parseAsString,
            logStart: parseAsString,
            logEnd: parseAsString,
            dbTable: parseAsString,
            dbView: parseAsString,
            dbPage: parseAsString,
            dbSort: parseAsString,
            dbDesc: parseAsString,
            dbFilters: parseAsString,
            statementsSort: parseAsString,
        },
        { shallow: true, scroll: false },
    );

    function select(nodeId: string | null) {
        if (nodeId === selected.current) return;

        void deployment.set(null);
        void tab.set(null);
        void file.set(null);
        void panelState.set(null);
        void selected.set(nodeId);
    }

    let pendingSelect: ReturnType<typeof setTimeout> | undefined;

    // A click on a card's name may be the first half of a double-click rename. Opening the panel
    // right away would slide it over the card and eat the second click, so it waits briefly.
    function clickNode(
        nodeId: string,
        event: MouseEvent | TouchEvent,
    ) {
        clearTimeout(pendingSelect);

        const onName =
            event.target instanceof Element &&
            event.target.closest("[data-renamable]");

        if (!onName) select(nodeId);
        else if (event instanceof MouseEvent && event.detail === 1)
            pendingSelect = setTimeout(() => select(nodeId), 300);
    }

    const clock = $state({ now: Date.now() });

    setCanvasClock(clock);

    setCanvasCluster({
        get id() {
            return clusterId;
        },
    });

    onMount(() => {
        const timer = setInterval(
            () => (clock.now = Date.now()),
            15_000,
        );

        return () => clearInterval(timer);
    });

    const canvasLayout = new CanvasLayout(() => projectId);

    let dialogs = $state<CanvasResourceDialogs>();

    let collapsed = $state.raw<ReadonlySet<string>>(new Set());

    // A menu's dialog in progress, `<action>:<groupId or resourceId>`; in the URL like other dialogs.
    const edit = useQueryState(
        "edit",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    const editing = $derived.by(() => {
        const [action, resourceId] = (edit.current ?? "").split(":");

        return {
            action: [
                "rename",
                "icon-upload",
                "icon-link",
                "new-group",
                "move-service",
                "move",
                "copy",
                "duplicate",
            ].find((name): name is GroupAction => name === action),
            group: groups.find((group) => group.id === resourceId),
            resource: resources.find(
                (resource) => resource.id === resourceId,
            ),
        };
    });

    // Only groups something is in have a frame, so only they are offered.
    const framedGroups = $derived(
        groups.flatMap((group) =>
            resources.some(
                (resource) => resource.groupId === group.id,
            )
                ? [{ id: group.id, name: group.name }]
                : [],
        ),
    );

    setCanvasActions({
        edit: (action, resourceId) =>
            void edit.set(`${action}:${resourceId}`),
        rename,
        toggleCollapsed: (resourceId) => {
            const next = new Set(collapsed);

            if (!next.delete(resourceId)) next.add(resourceId);

            collapsed = next;
            saveCollapsed(projectId, next);
        },
        isCollapsed: (resourceId) => collapsed.has(resourceId),
        remove: (resourceId) =>
            void setPendingDelete(resourceId, true),
        restore: (resourceId) =>
            void setPendingDelete(resourceId, false),
        isPendingDelete: (resourceId) =>
            graph.find((item) => item.id === resourceId)
                ?.pendingDelete ?? false,
        redeploy: (resourceId) => dialogs?.askRedeploy(resourceId),
        canRedeploy: (resourceId) =>
            !graph.find((item) => item.id === resourceId)?.changed,
        setRunning: (resourceId, running) => {
            if (running) void dialogs?.start(resourceId);
            else dialogs?.askStop(resourceId);
        },
        // Read when the menu opens, from the cache the card's status already fills.
        runState: (resourceId) => {
            const resource = resources.find(
                (item) => item.id === resourceId,
            );

            if (
                resource?.deploymentStatus !== "ready" ||
                resource.bucketStatus
            )
                return undefined;

            const containers = queryClient.getQueryData(
                orpc.resources.getProjectContainers.queryKey({
                    input: { clusterId, projectId },
                }),
            )?.[resourceId];

            return containers && allExited(containers)
                ? "stopped"
                : "running";
        },
        setGroup: (resourceId, groupId) =>
            void setGroup(resourceId, groupId),
        selectService: (resourceId, service) =>
            select(serviceNodeId(resourceId, service)),
        selectVolume: (resourceId, volume) =>
            select(volumeNodeId(resourceId, volume)),
        selectMetrics: (nodeId) => {
            select(nodeId);
            void tab.set("metrics");
        },
        removeVolume: (nodeId) => dialogs?.askRemoveVolume(nodeId),
        disconnectVolume: (nodeId) =>
            void dialogs?.disconnectVolume(nodeId),
        isVolumeMounted: (nodeId) => {
            const { resourceId, volume } = parseNodeId(nodeId);

            return (
                graph
                    .find((entry) => entry.id === resourceId)
                    ?.volumes.some(
                        (item) =>
                            item.name === volume &&
                            item.services.length > 0,
                    ) ?? false
            );
        },
        selectConfig: (resourceId, config) =>
            select(configNodeId(resourceId, config)),
        removeConfig: (nodeId) => dialogs?.askRemoveConfig(nodeId),
        disconnectConfig: (nodeId) =>
            void dialogs?.disconnectConfig(nodeId),
        isConfigMounted: (nodeId) => {
            const { resourceId, config } = parseNodeId(nodeId);

            return (
                graph
                    .find((entry) => entry.id === resourceId)
                    ?.configs.some(
                        (item) =>
                            item.name === config &&
                            item.services.length > 0,
                    ) ?? false
            );
        },
        ungroup: (groupId) => void ungroup(groupId),
    });

    async function refreshGraph() {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            }),
            queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            }),
            queryClient.invalidateQueries({
                queryKey: orpc.resources.listGroups.key(),
            }),
        ]);
    }

    // updateDetails replaces every field, so the ones not being renamed are sent unchanged.
    async function rename(resourceId: string, name: string) {
        const resource = resources.find(
            (item) => item.id === resourceId,
        );

        if (!resource || name === resource.name) return;

        try {
            await client.resources.updateDetails({
                projectId,
                resourceId,
                name,
                description: resource.description ?? undefined,
                icon: resource.icon ?? undefined,
            });
        } catch (error) {
            moveNotice = {
                message:
                    error instanceof Error
                        ? error.message
                        : "The resource could not be renamed.",
                warnings: [],
            };
        }

        await refreshGraph();
    }

    // Railway's "Delete Service": staged like any other change and applied from the bar.
    async function setPendingDelete(
        resourceId: string,
        pendingDelete: boolean,
    ) {
        try {
            await client.resources.setPendingDelete({
                projectId,
                resourceId,
                pendingDelete,
            });
        } catch (error) {
            moveNotice = {
                message:
                    error instanceof Error
                        ? error.message
                        : "The resource could not be updated.",
                warnings: [],
            };
        }

        await queryClient.invalidateQueries({
            queryKey: orpc.resources.getProjectGraph.key(),
        });
    }

    onMount(() => () => canvasLayout.flush());

    // Runs before the build effect, so the first render already uses the saved layout.
    $effect.pre(() => {
        // Only a project switch reloads; refetches must not clobber local drags.
        canvasLayout.load(
            loadPositions(projectId) ?? untrack(() => layout),
        );
        collapsed = loadCollapsed(projectId);
    });

    let nodes = $state.raw<CanvasNode[]>([]);

    let edges = $state.raw<Edge[]>([]);

    // A drag in progress; live refetches wait for it so cards never snap back mid-drag.
    let drag:
        | {
              /** Cards that move with the drag and where they started. */
              starts: Map<string, { x: number; y: number }>;
              frameId: string | undefined;
              target: string | undefined;
          }
        | undefined;

    // Live status refetches rebuild the graph; dragged positions survive through `positions`.
    // Selection comes from the URL so a shared link highlights the same card.
    $effect(() => {
        const built = buildCanvas(
            resources,
            graph,
            groups,
            logos,
            canvasLayout.positions,
            collapsed,
        );

        const current = selected.current;

        if (untrack(() => drag)) return;

        // A selected service lights up its resource's card.
        nodes = built.nodes.map((node) => ({
            ...node,
            selected:
                node.id === current ||
                current?.startsWith(`${node.id}:`) === true,
        }));
        edges = styleEdges(built.edges, current, hidden.current);
    });

    // Railway highlights the selected card's connections; a selected group lights its own too.
    function styleEdges(
        plain: Edge[],
        current: string | null,
        hiddenLayers: EdgeLayer[],
    ) {
        if (hiddenLayers.includes("references")) return [];

        return plain.map((edge) => {
            const active = [edge.source, edge.target].some(
                (id) =>
                    id === current || id.startsWith(`${current}:`),
            );

            return {
                ...edge,
                class: active ? "is-active" : undefined,
                // Railway's elbows are rounded by 5px.
                pathOptions: { borderRadius: 5 },
                zIndex: active ? 1 : 0,
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    width: 24,
                    height: 24,
                    color: active
                        ? "var(--foreground)"
                        : "var(--canvas-edge)",
                },
            };
        });
    }

    const selectedNode = $derived(
        selected.current ? parseNodeId(selected.current) : undefined,
    );

    const selectedResourceId = $derived(selectedNode?.resourceId);

    const selectedService = $derived(selectedNode?.service);

    const selectedResource = $derived(
        resources.find(
            (resource) => resource.id === selectedResourceId,
        ),
    );

    const selectedGraph = $derived(
        graph.find((entry) => entry.id === selectedResourceId),
    );

    const volumeTargetList = $derived(
        volumeTargets(resources, graph, logos),
    );

    const selectedVolume = $derived(
        selectedNode?.volume === undefined
            ? undefined
            : selectedGraph?.volumes.find(
                  (volume) => volume.name === selectedNode.volume,
              ),
    );

    const selectedConfig = $derived(
        selectedNode?.config === undefined
            ? undefined
            : selectedGraph?.configs.find(
                  (config) => config.name === selectedNode.config,
              ),
    );

    // A service or a tray volume or config isn't a flow node, so the camera focuses its card.
    const focusNodeId = $derived(
        (
            nodes.find((node) => node.id === selected.current) ??
            (selectedResourceId
                ? resourceCard(selectedResourceId)
                : undefined)
        )?.id,
    );

    const selectedIcon = $derived(
        nodes.find((node) => node.id === focusNodeId)?.data.icon ??
            null,
    );

    const panel = new PanelSize(() => select(null));

    function contains(frame: Rect, point: { x: number; y: number }) {
        return (
            point.x >= frame.x &&
            point.x <= frame.x + frame.width &&
            point.y >= frame.y &&
            point.y <= frame.y + frame.height
        );
    }

    function startDrag(dragged: CanvasNode) {
        // A frame carries its cards; a card moves alone.
        const moving = nodes.filter((node) =>
            dragged.type === "stack"
                ? node.type === "card" &&
                  node.data.frameId === dragged.id
                : node.id === dragged.id,
        );

        drag = {
            // Copies: xyflow moves the live position objects while dragging.
            starts: new Map(
                moving.map((node) => [node.id, { ...node.position }]),
            ),
            frameId:
                dragged.type === "stack" ? dragged.id : undefined,
            target: undefined,
        };
    }

    function moveDrag(
        dragged: CanvasNode,
        pointer: { x: number; y: number } | undefined,
    ) {
        if (!drag) return;

        const start = drag.frameId ? frameStart : undefined;

        const delta = start
            ? {
                  x: dragged.position.x - start.x,
                  y: dragged.position.y - start.y,
              }
            : undefined;

        // Railway's drop target: another group's frame under the pointer. Volumes and configs
        // on their own follow their resource, so only a resource's card joins a group.
        const card =
            dragged.type === "card" &&
            !dragged.data.volume &&
            !dragged.data.config
                ? dragged
                : undefined;

        // Hit-test the pointer, like Railway; the node's own position lags a frame behind.
        const point =
            card && pointer && toFlow ? toFlow(pointer) : undefined;

        const target = point
            ? nodes.find(
                  (node) =>
                      node.type === "stack" &&
                      node.data.group !== undefined &&
                      node.id !== card?.data.groupId &&
                      contains(
                          {
                              ...node.position,
                              width: node.width ?? 0,
                              height: node.height ?? 0,
                          },
                          point,
                      ),
              )?.id
            : undefined;

        drag.target = target;

        const moved = nodes.map((node): CanvasNode => {
            const origin = drag?.starts.get(node.id);

            if (delta && origin && node.id !== dragged.id)
                return {
                    ...node,
                    position: {
                        x: origin.x + delta.x,
                        y: origin.y + delta.y,
                    },
                };

            if (node.type === "stack")
                return {
                    ...node,
                    data: {
                        ...node.data,
                        dropTarget: node.id === target,
                    },
                };

            return node;
        });

        // The dragged frame refits to its cards too, so it never drifts from them.
        nodes = refitFrames(moved);
        edges = styleEdges(
            buildEdges(nodes, graph),
            selected.current,
            hidden.current,
        );
    }

    let frameStart: { x: number; y: number } | undefined;

    let toFlow = $state<
        (point: { x: number; y: number }) => {
            x: number;
            y: number;
        }
    >();

    // Saved changes that are not live yet, and the running services deploying them removes.
    const changes = $derived(
        resources.flatMap((resource) => {
            const entry = graph.find(
                (item) => item.id === resource.id,
            );

            return entry?.changed
                ? [
                      {
                          resource,
                          removed: entry.removed,
                          pendingDelete: entry.pendingDelete,
                      },
                  ]
                : [];
        }),
    );

    let moveNotice = $state<{
        message: string;
        warnings: string[];
    }>();

    let moving = $state(false);

    let moveError = $state("");

    // Saves where every card is now: a shift-selection moves several at once.
    function persistCards() {
        const next = { ...canvasLayout.positions };

        for (const node of nodes)
            if (node.type === "card") next[node.id] = node.position;

        canvasLayout.commit(next);
    }

    function withPositions(list: CanvasNode[], moved: Positions) {
        return refitFrames(
            list.map((node) => {
                const position = moved[node.id];

                return position ? { ...node, position } : node;
            }),
        );
    }

    // Cards never sit right on top of each other: the drop cascades off any card it landed on,
    // and a frame that grew into a neighbour moves clear of it with its cards.
    function settleDragged(id: string) {
        let next = withPositions(nodes, settle(nodes, id));
        const card = next.find((node) => node.id === id);

        if (card?.type === "card" && card.data.frameId)
            next = withPositions(
                next,
                settle(next, card.data.frameId),
            );

        nodes = next;
    }

    function endDrag(dragged: CanvasNode) {
        const target = drag?.target;
        const startedAt = drag?.starts.get(dragged.id);

        drag = undefined;
        frameStart = undefined;

        if (!target) settleDragged(dragged.id);

        persistCards();

        if (!target || dragged.type !== "card") return;

        // setGroup lands it and its sibling cards without covering the frame's cards.
        void setGroup(
            dragged.data.resource.id,
            target,
            { ...dragged.position },
            startedAt,
            dragged,
        );
    }

    // Cards of a group's frame, as rectangles.
    function memberRects(groupId: string) {
        return nodes.flatMap((node) =>
            node.type === "card" && node.data.frameId === groupId
                ? [nodeRect(node)]
                : [],
        );
    }

    // Frames and lone cards: what a card leaving a frame must not land on.
    function blockRects() {
        return nodes.flatMap((node) =>
            node.type === "stack" || !node.data.frameId
                ? [nodeRect(node)]
                : [],
        );
    }

    // Beside its old frame, clear of everything else.
    function outsideFrame(card: CanvasNode, groupId: string) {
        const frame = frameRect(memberRects(groupId));

        return nearestFree(
            {
                ...nodeRect(card),
                x: frame.x + frame.width + COLUMN_GAP,
            },
            blockRects(),
        );
    }

    // A resource's card, or its first service's card when it has several.
    function resourceCard(resourceId: string) {
        return nodes.find(
            (node) =>
                node.type === "card" &&
                node.data.resource.id === resourceId &&
                !node.data.volume &&
                !node.data.config,
        );
    }

    // Railway's "Group ›": into a group's frame, or out of it (null). Only the layout changes.
    async function setGroup(
        resourceId: string,
        groupId: string | null,
        landing?: { x: number; y: number },
        // Where the card was before a drag moved it; its own cards keep their offset from there.
        origin?: { x: number; y: number },
        // The dragged card; the menu moves the resource by its first card.
        card = resourceCard(resourceId),
    ) {
        if (card?.type !== "card" || card.data.groupId === groupId)
            return;

        const members = groupId ? memberRects(groupId) : [];

        const spot =
            landing ??
            (groupId
                ? members.length
                    ? slotBelow(members)
                    : card.position
                : card.data.groupId
                  ? outsideFrame(card, card.data.groupId)
                  : card.position);

        try {
            await client.resources.setGroup({
                projectId,
                resourceId,
                groupId,
            });
            canvasLayout.place({
                ...canvasLayout.positions,
                ...landResourceCards(
                    nodes,
                    card.id,
                    origin ?? card.position,
                    spot,
                    members,
                ),
            });
        } catch (error) {
            moveNotice = {
                message:
                    error instanceof Error
                        ? error.message
                        : "The resource could not be regrouped.",
                warnings: [],
            };
        }

        await refreshGraph();
    }

    // Railway's "Remove Group": the frame goes, its resources stay where they are.
    async function ungroup(groupId: string) {
        try {
            await client.resources.deleteGroup({
                projectId,
                groupId,
            });
        } catch (error) {
            moveNotice = {
                message:
                    error instanceof Error
                        ? error.message
                        : "The group could not be removed.",
                warnings: [],
            };
        }

        await refreshGraph();
    }

    // Moving a resource's only service removes the resource, which the dialog warns about.
    async function moveService(
        from: CanvasResource,
        service: string,
        toResourceId: string | null,
    ) {
        const to = resources.find(
            (resource) => resource.id === toResourceId,
        );

        const card = resourceCard(from.id);

        moving = true;
        moveError = "";

        try {
            const result = await client.resources.moveService({
                projectId,
                fromResourceId: from.id,
                toResourceId: to?.id,
                service,
                removeEmptySource:
                    graph.find((entry) => entry.id === from.id)
                        ?.services.length === 1,
            });

            // A new resource lands beside the card it came out of.
            if (!to && card)
                canvasLayout.place({
                    ...canvasLayout.positions,
                    [result.resourceId]: nearestFree(
                        {
                            ...nodeRect(card),
                            x:
                                card.position.x +
                                (card.width ?? 0) +
                                COLUMN_GAP,
                        },
                        blockRects(),
                    ),
                });

            void edit.set(null);
            moveNotice = {
                message: !to
                    ? `Moved ${service} into a resource of its own. Deploy to apply it.`
                    : result.removedResourceId
                      ? `Moved ${service} into ${to.name} and removed ${from.name}. Deploy ${to.name} to start it there.`
                      : `Moved ${service} into ${to.name}. Deploy both to apply it.`,
                warnings: result.warnings,
            };
            await refreshGraph();
        } catch (error) {
            moveError =
                error instanceof Error
                    ? error.message
                    : "The service could not be moved.";
        } finally {
            moving = false;
        }
    }

    function resetLayout() {
        canvasLayout.commit({});
    }

    function repairLayout() {
        canvasLayout.commit({
            ...canvasLayout.positions,
            ...repairOverlaps(nodes),
        });
    }

    useHeaderActions(headerActions);
</script>

{#snippet headerActions()}
    <div class="flex items-center gap-2">
        {#if changes.length}
            <!-- Centered in the header on wide screens; narrow ones keep it inline. -->
            <div
                class="border-e pe-2 md:absolute md:left-1/2 md:-translate-x-1/2 md:border-none md:pe-0"
            >
                <ApplyBar {projectId} {changes} />
            </div>
        {/if}
        {#if !empty && !isInternal}
            <Button
                size="sm"
                variant="outline"
                onclick={() => void add.set("root")}
                aria-label="Add"
            >
                <Plus class="size-4" aria-hidden="true" />
                <span class="max-sm:hidden">Add</span>
                <KbdGroup class="hidden sm:inline-flex">
                    <Kbd>Ctrl</Kbd>
                    <Kbd>K</Kbd>
                </KbdGroup>
            </Button>
        {/if}
    </div>
{/snippet}

<!-- Capture runs before focused widgets like the metric charts, which swallow Escape. -->
<svelte:window
    onkeydowncapture={(event) => {
        const typing =
            event.target instanceof HTMLElement &&
            event.target.closest(
                "input, textarea, [contenteditable], [role=dialog], [role=alertdialog], [role=menu]",
            );

        // Undo and redo the layout, like Railway: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y.
        if (!typing && (event.ctrlKey || event.metaKey)) {
            const key = event.key.toLowerCase();

            if (key === "z" || key === "y") {
                event.preventDefault();

                if (key === "y" || event.shiftKey)
                    canvasLayout.redo();
                else canvasLayout.undo();

                return;
            }
        }

        // Ctrl/Cmd+K opens the add palette, from anywhere on the page.
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "k" &&
            !empty &&
            !isInternal &&
            !add.current
        ) {
            event.preventDefault();
            void add.set("root");

            return;
        }

        // Railway: Escape closes the details panel, unless a dialog or field has focus.
        if (
            event.key !== "Escape" ||
            !selected.current ||
            edit.current ||
            add.current ||
            typing
        )
            return;

        // An open deployment steps back to the panel first.
        if (deployment.current) void deployment.set(null);
        else select(null);
    }}
/>

<div
    class="project-canvas relative size-full"
    bind:this={panel.canvasElement}
    bind:clientWidth={panel.canvasWidth}
>
    <CanvasContextMenu
        {projectId}
        target={menuTarget}
        groups={framedGroups}
        canAdd={!isInternal}
        canAddVolume={volumeTargetList.length > 0}
        onaddpage={(addPage) => void add.set(addPage)}
        onopen={openPanel}
    >
        <SvelteFlow
            bind:nodes
            bind:edges
            {nodeTypes}
            connectionMode={ConnectionMode.Loose}
            nodesConnectable={false}
            elementsSelectable
            deleteKey={null}
            fitView={fitOnLoad}
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            minZoom={0.5}
            maxZoom={1.26}
            panOnScroll
            selectionMode={SelectionMode.Partial}
            snapGrid={[SNAP_GRID, SNAP_GRID]}
            defaultEdgeOptions={{
                type: "smoothstep",
                selectable: false,
            }}
            onnodeclick={({ node, event }) =>
                clickNode(node.id, event)}
            onpaneclick={() => {
                clearTimeout(pendingSelect);
                select(null);
            }}
            onnodecontextmenu={({ node, event }) => {
                // A resource's own frame opens that resource's menu.
                if (node.type === "stack") {
                    menuTarget = node.data.group
                        ? { kind: "group", groupId: node.id }
                        : {
                              kind: "node",
                              nodeId: node.id,
                              groupId: undefined,
                              services: 1,
                          };

                    return;
                }

                // A volume or config in a service's tray has its own menu, like Railway's.
                const tray =
                    event.target instanceof Element
                        ? event.target.closest<HTMLElement>(
                              "[data-volume], [data-config]",
                          )?.dataset
                        : undefined;

                const resourceId = node.data.resource.id;

                menuTarget = {
                    kind: "node",
                    nodeId: tray?.config
                        ? configNodeId(resourceId, tray.config)
                        : tray?.volume
                          ? volumeNodeId(resourceId, tray.volume)
                          : node.id,
                    groupId: node.data.groupId,
                    services: node.data.service ? 1 : 0,
                };
            }}
            onpanecontextmenu={() => (menuTarget = { kind: "pane" })}
            onnodedragstart={({ targetNode }) => {
                if (!targetNode) return;

                frameStart = { ...targetNode.position };
                startDrag(targetNode);
            }}
            onnodedrag={({ targetNode, event }) => {
                if (!targetNode) return;

                const pointer =
                    "clientX" in event
                        ? { x: event.clientX, y: event.clientY }
                        : event.touches[0]
                          ? {
                                x: event.touches[0].clientX,
                                y: event.touches[0].clientY,
                            }
                          : undefined;

                moveDrag(targetNode, pointer);
            }}
            onnodedragstop={({ targetNode }) => {
                if (targetNode) endDrag(targetNode);
            }}
            onselectiondragstart={() => {
                // A box selection moves as one; live refetches wait for it like a single drag.
                drag = {
                    starts: new Map(),
                    frameId: undefined,
                    target: undefined,
                };
            }}
            onselectiondrag={() => {
                nodes = refitFrames(nodes);
                edges = styleEdges(
                    buildEdges(nodes, graph),
                    selected.current,
                    hidden.current,
                );
            }}
            onselectiondragstop={() => {
                drag = undefined;

                // Each moved node settles in turn, so the selection never lands on anything.
                for (const node of nodes.filter(
                    (item) => item.selected,
                ))
                    settleDragged(node.id);

                persistCards();
            }}
        >
            <CanvasDots />
            <CanvasApi bind:toFlow />
            <!-- An empty project has nothing to zoom, undo or add beside the palette, as in Railway. -->
            {#if !empty}
                <Panel position="bottom-left" class="m-4!">
                    <CanvasControls
                        hidden={hidden.current}
                        canUndo={canvasLayout.canUndo}
                        canRedo={canvasLayout.canRedo}
                        onlayers={(next) =>
                            void hidden.set(
                                next.length ? next : null,
                            )}
                        onautolayout={resetLayout}
                        onrepair={repairLayout}
                        onundo={() => canvasLayout.undo()}
                        onredo={() => canvasLayout.redo()}
                    />
                </Panel>
            {/if}
            <CanvasFocus
                nodeId={selectedResource ? focusNodeId : undefined}
                coveredWidth={panel.narrow ? 0 : panel.width}
            />
        </SvelteFlow>
    </CanvasContextMenu>

    <!-- Stops where the resource panel starts, so notices and actions never sit on top of it. -->
    <div
        class="pointer-events-none absolute inset-y-0 left-0 z-30"
        class:hidden={panel.narrow && selectedResource}
        style:right="{selectedResource ? panel.width : 0}px"
    >
        {#if moveNotice}
            <div
                class="pointer-events-auto absolute top-4 left-1/2 w-[min(32rem,90%)] -translate-x-1/2"
            >
                <Alert
                    variant={moveNotice.warnings.length
                        ? "warning"
                        : "info"}
                >
                    <AlertDescription>
                        <p>{moveNotice.message}</p>
                        {#each moveNotice.warnings as warning (warning)}
                            <p>{warning}</p>
                        {/each}
                    </AlertDescription>
                    <AlertAction>
                        <Button
                            size="sm"
                            variant="ghost"
                            onclick={() => (moveNotice = undefined)}
                        >
                            Dismiss
                        </Button>
                    </AlertAction>
                </Alert>
            </div>
        {/if}
    </div>

    {#if empty && !isInternal}
        <!-- Pinned near the top like the dialog: centred, the box would move as pages change length
             and slide another row under a resting pointer. -->
        <div
            class="pointer-events-none absolute inset-0 flex items-start justify-center px-4 pt-[max(4rem,15vh)]"
        >
            <div class="pointer-events-auto">
                <AddPalette
                    {projectId}
                    inline
                    volumeTargets={volumeTargetList}
                    oncreated={select}
                />
            </div>
        </div>
    {/if}

    {#if selectedResource && selectedConfig}
        {#key selected.current}
            <CanvasConfigPanel
                resource={selectedResource}
                config={selectedConfig}
                services={selectedGraph?.services ?? []}
                width={panel.width}
                inset={panel.narrow}
                full={panel.full}
                onclose={() => select(null)}
                onremove={() =>
                    dialogs?.askRemoveConfig(selected.current ?? "")}
            />
        {/key}
    {:else if selectedResource && selectedVolume}
        {#key selected.current}
            <CanvasVolumePanel
                resource={selectedResource}
                volume={selectedVolume}
                services={selectedGraph?.services ?? []}
                width={panel.width}
                inset={panel.narrow}
                full={panel.full}
                onclose={() => select(null)}
                onremove={() =>
                    dialogs?.askRemoveVolume(selected.current ?? "")}
            />
        {/key}
    {:else if selectedResource}
        {#key selectedResource.id}
            <CanvasPanel
                {clusterId}
                resource={selectedResource}
                services={selectedGraph?.services ?? []}
                {selectedService}
                icon={selectedIcon}
                changed={selectedGraph?.changed ?? false}
                width={panel.width}
                inset={panel.narrow}
                full={panel.full}
                onclose={() => select(null)}
            />
        {/key}
    {/if}

    {#if selectedResource && !panel.narrow}
        <!-- Like the sidebar rail: drag the panel's left edge to resize it, to the far left to fill the canvas, past the minimum to close it. -->
        <div
            class={[
                "group absolute bottom-0 z-30 w-3 cursor-col-resize touch-none transition-[top] duration-300",
                panel.full ? "top-0" : "top-6",
            ]}
            style:right="{Math.min(panel.width, panel.canvasWidth) -
                12}px"
            aria-hidden="true"
            onpointerdown={panel.startResize}
            onpointermove={panel.resize}
            onpointerup={panel.endResize}
            onlostpointercapture={panel.endResize}
        >
            <div
                class={[
                    "absolute top-1/2 left-1/2 h-12 w-1 -translate-1/2 rounded-full bg-border transition-[height,background-color] group-hover:h-16 group-hover:bg-muted-foreground",
                    panel.resizing && "h-16 bg-muted-foreground",
                ]}
            ></div>
        </div>
    {/if}
</div>

{#if !empty && !isInternal}
    <AddPalette
        {projectId}
        volumeTargets={volumeTargetList}
        oncreated={select}
    />
{/if}

<CanvasResourceDialogs
    bind:this={dialogs}
    {projectId}
    {resources}
    {graph}
    selected={selected.current}
    onclose={() => select(null)}
    onopen={openPanel}
    {clusterId}
    onerror={(message) => (moveNotice = { message, warnings: [] })}
/>

<GroupDialogs
    {projectId}
    group={editing.group}
    resource={editing.resource}
    action={editing.action}
    onclose={() => void edit.set(null)}
/>

{#if editing.action === "move-service" && editing.resource}
    {@const from = editing.resource}
    <MoveServiceDialog
        resource={from}
        services={(
            graph.find((entry) => entry.id === from.id)?.services ??
            []
        ).map((service) => service.name)}
        targets={resources.filter(
            (resource) =>
                resource.id !== from.id && resource.type !== "bucket",
        )}
        pending={moving}
        error={moveError}
        onmove={(service, toResourceId) =>
            void moveService(from, service, toResourceId)}
        onclose={() => {
            moveError = "";
            void edit.set(null);
        }}
    />
{/if}

<style>
    /* Map Svelte Flow's theme variables onto Stoat tokens so both themes follow the app. */
    /* One colour for connection lines and their arrowheads, like Railway's #6C6B7B. */
    .project-canvas {
        --canvas-edge: color-mix(
            in oklab,
            var(--muted-foreground) 80%,
            transparent
        );
    }

    .project-canvas :global(.svelte-flow) {
        --xy-background-color: var(--background);
        --xy-edge-stroke: var(--canvas-edge);
        --xy-edge-stroke-width: 1;
        --xy-node-border-radius: var(--radius-xl);
        --xy-selection-background-color: color-mix(
            in oklab,
            var(--ring) 8%,
            transparent
        );
        --xy-selection-border: 1px dashed var(--ring);
    }

    /* Railway draws connections as thin dashed lines. */
    /* Railway draws connections as 1px dashes, brighter when they touch the selected card. */
    .project-canvas :global(.svelte-flow__edge-path) {
        stroke-dasharray: 5 5;
    }

    .project-canvas
        :global(
            .svelte-flow__edge.is-active .svelte-flow__edge-path
        ) {
        stroke: var(--foreground);
    }

    /* Svelte Flow asks to keep its attribution without a Pro plan; keep it quiet instead. */
    .project-canvas :global(.svelte-flow__attribution) {
        background: transparent;
        opacity: 0.4;
    }
</style>
