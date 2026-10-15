<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import Plus from "@lucide/svelte/icons/plus";
    import {
        Background,
        BackgroundVariant,
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
    import CanvasFocus from "./canvas-focus.svelte";
    import {
        setCanvasActions,
        setCanvasClock,
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
    import {
        buildCanvas,
        buildEdges,
        COLUMN_GAP,
        frameRect,
        freeSlot,
        loadCollapsed,
        loadPositions,
        nearestFree,
        nodeRect,
        refitFrames,
        repairOverlaps,
        saveCollapsed,
        savePositions,
        settle,
        slotBelow,
        type CanvasGraph,
        type CanvasLogos,
        type CanvasNode,
        type CanvasResource,
        type Positions,
        type Rect,
    } from "./graph";
    import CardNode from "./nodes/card-node.svelte";
    import StackNode from "./nodes/stack-node.svelte";
    import CanvasPanel from "./panel/canvas-panel.svelte";

    let {
        projectId,
        clusterId,
        resources,
        graph,
        logos,
        layout,
    }: {
        projectId: string;
        clusterId: string;
        resources: CanvasResource[];
        graph: CanvasGraph;
        logos: CanvasLogos;
        layout: Positions;
    } = $props();

    const nodeTypes: NodeTypes = { card: CardNode, stack: StackNode };

    // Railway opens an empty project on its Add palette instead of an empty canvas.
    const empty = $derived(resources.length === 0);

    // `<resourceId>` or `<resourceId>:<service>`; a shared link reopens the same panel.
    const selected = useQueryState(
        "node",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // A link that opens a card lets CanvasFocus place the camera; fitting first would override it.
    const fitOnLoad = untrack(() => selected.current === null);

    // Stacked deployment logs belong to the selected node; a new selection drops them.
    const deployment = useQueryState(
        "deployment",
        parseAsString.withOptions({ shallow: true, scroll: false }),
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
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // Transient, so plain state: only which menu the next right-click shows.
    let menuTarget = $state<MenuTarget>();

    function openPanel(nodeId: string, panelTab: PanelTab) {
        select(nodeId);
        void tab.set(panelTab);
    }

    // Per-resource panel state (search, filters, expanded rows) belongs to the node it was set on.
    const panelState = useQueryStates(
        {
            details: parseAsBoolean,
            hideHistory: parseAsBoolean,
            settingsFilter: parseAsString,
            variableSearch: parseAsString,
        },
        { shallow: true, scroll: false },
    );

    function select(nodeId: string | null) {
        if (nodeId === selected.current) return;

        void deployment.set(null);
        void panelState.set(null);
        void selected.set(nodeId);
    }

    const clock = $state({ now: Date.now() });

    setCanvasClock(clock);

    onMount(() => {
        const timer = setInterval(
            () => (clock.now = Date.now()),
            15_000,
        );

        return () => clearInterval(timer);
    });

    let positions = $state.raw<Positions>({});

    let collapsed = $state.raw<ReadonlySet<string>>(new Set());

    // A frame's ⋮ menu edit in progress, `<action>:<resourceId>`; in the URL like other dialogs.
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
                "move",
                "copy",
            ].find((name): name is GroupAction => name === action),
            resource: resources.find(
                (resource) => resource.id === resourceId,
            ),
        };
    });

    setCanvasActions({
        edit: (action, resourceId) =>
            void edit.set(`${action}:${resourceId}`),
        toggleCollapsed: (resourceId) => {
            const next = new Set(collapsed);

            if (!next.delete(resourceId)) next.add(resourceId);

            collapsed = next;
            saveCollapsed(projectId, next);
        },
        isCollapsed: (resourceId) => collapsed.has(resourceId),
        remove: (resourceId) => {
            pendingDelete = resources.find(
                (resource) => resource.id === resourceId,
            );
            deleteError = "";
        },
        redeploy: (resourceId) => {
            pendingRedeploy = resources.find(
                (resource) => resource.id === resourceId,
            );
            redeployError = "";
        },
        canRedeploy: (resourceId) =>
            !graph.find((item) => item.id === resourceId)?.changed,
        regroup: (nodeId, toResourceId) =>
            void regroup(nodeId, toResourceId),
        ungroup: (resourceId) => void ungroup(resourceId),
    });

    // Railway's "Delete Service", for a whole resource: confirmed in an alert dialog first.
    let pendingDelete = $state<CanvasResource>();

    let deleting = $state(false);

    let deleteError = $state("");

    async function deleteResource() {
        if (!pendingDelete) return;

        deleting = true;
        deleteError = "";

        try {
            await client.resources.deleteResource({
                projectId,
                resourceId: pendingDelete.id,
            });

            if (selected.current?.split(":")[0] === pendingDelete.id)
                select(null);

            pendingDelete = undefined;
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
            ]);
        } catch (error) {
            deleteError =
                error instanceof Error
                    ? error.message
                    : "The resource could not be deleted.";
        } finally {
            deleting = false;
        }
    }

    // Railway's "Redeploy": recreates the containers from the live config, even when nothing changed.
    let pendingRedeploy = $state<CanvasResource>();

    let redeploying = $state(false);

    let redeployError = $state("");

    async function redeployResource() {
        if (!pendingRedeploy) return;

        const resourceId = pendingRedeploy.id;

        redeploying = true;
        redeployError = "";

        try {
            await client.resources.deploy({
                projectId,
                resourceId,
                recreate: true,
            });

            pendingRedeploy = undefined;
            openPanel(resourceId, "deployments");
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
            ]);
        } catch (error) {
            redeployError =
                error instanceof Error
                    ? error.message
                    : "The resource could not be redeployed.";
        } finally {
            redeploying = false;
        }
    }

    // The layout is shared by the project, so it is saved to the server; a burst of drags and
    // undos collapses into one write of the latest snapshot.
    let pendingLayout: Positions | undefined;

    let layoutTimer: ReturnType<typeof setTimeout> | undefined;

    function persistLayout(next: Positions) {
        savePositions(projectId, next);
        pendingLayout = next;
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(flushLayout, 500);
    }

    function flushLayout() {
        clearTimeout(layoutTimer);

        if (!pendingLayout) return;

        const saved = pendingLayout;
        const savedFor = projectId;

        pendingLayout = undefined;

        client.projects
            .setCanvasLayout({ projectId: savedFor, layout: saved })
            .then(() => {
                // A later visit must not paint the older layout from the cache.
                queryClient.setQueryData(
                    orpc.projects.getProject.queryKey({
                        input: { projectId: savedFor },
                    }),
                    (project) =>
                        project && {
                            ...project,
                            canvasLayout: saved,
                        },
                );
            })
            .catch(() => {
                // An unsaved layout only resets on the next visit.
            });
    }

    onMount(() => flushLayout);

    // Railway's undo/redo, for layout: each entry is a whole snapshot of card positions.
    let past = $state.raw<Positions[]>([]);

    let future = $state.raw<Positions[]>([]);

    function commit(next: Positions) {
        past = [...past.slice(-49), positions];
        future = [];
        positions = next;
        persistLayout(next);
    }

    function undo() {
        const previous = past.at(-1);

        if (!previous) return;

        past = past.slice(0, -1);
        future = [positions, ...future];
        positions = previous;
        persistLayout(previous);
    }

    function redo() {
        const [next, ...rest] = future;

        if (!next) return;

        future = rest;
        past = [...past, positions];
        positions = next;
        persistLayout(next);
    }

    // Runs before the build effect, so the first render already uses the saved layout.
    $effect.pre(() => {
        // Only a project switch reloads; refetches must not clobber local drags.
        positions = loadPositions(projectId) ?? untrack(() => layout);
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
            logos,
            positions,
            collapsed,
        );

        const current = selected.current;

        if (untrack(() => drag)) return;

        nodes = built.nodes.map((node) => ({
            ...node,
            selected: node.id === current,
        }));
        edges = styleEdges(built.edges, current, hidden.current);
    });

    // Railway highlights the selected card's connections; a selected group lights its own too.
    function styleEdges(
        plain: Edge[],
        current: string | null,
        hiddenLayers: EdgeLayer[],
    ) {
        // Edge ids start with their kind: `reference:` or `depends:`.
        const shown = plain.filter(
            (edge) =>
                !hiddenLayers.includes(
                    edge.id.startsWith("reference:")
                        ? "references"
                        : "dependencies",
                ),
        );

        return shown.map((edge) => {
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

    const selectedResourceId = $derived(
        selected.current?.split(":")[0],
    );

    const selectedService = $derived(
        selected.current?.includes(":")
            ? selected.current.slice(
                  selected.current.indexOf(":") + 1,
              )
            : undefined,
    );

    const selectedResource = $derived(
        resources.find(
            (resource) => resource.id === selectedResourceId,
        ),
    );

    const selectedGraph = $derived(
        graph.find((entry) => entry.id === selectedResourceId),
    );

    const selectedIcon = $derived(
        nodes.find((node) => node.id === selectedResourceId)?.data
            .icon ?? null,
    );

    let canvasWidth = $state(0);

    // Railway hides the graph on narrow screens and gives the panel all of it, inset 20px per side.
    const narrow = $derived(canvasWidth < 900);

    // Wider canvases step the docked panel up to a fixed width, as Railway does: 70% to 1150px, then 904, 1008 and 1184px.
    const panelWidth = $derived.by(() => {
        if (narrow) return Math.max(canvasWidth - 40, 0);

        if (canvasWidth < 1150) return Math.round(canvasWidth * 0.7);

        if (canvasWidth < 1400) return 904;

        if (canvasWidth < 1700) return 1008;

        return 1184;
    });

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
                  node.data.grouped &&
                  node.data.resource.id === dragged.id
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

        // Railway's drop target: another resource's frame under the dragged card's centre.
        const card =
            dragged.type === "card" && dragged.data.service
                ? dragged
                : undefined;

        // Hit-test the pointer, like Railway; the node's own position lags a frame behind.
        const point =
            card && pointer && toFlow ? toFlow(pointer) : undefined;

        const target = point
            ? nodes.find(
                  (node) =>
                      node.type === "stack" &&
                      node.id !== card?.data.resource.id &&
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
                ? [{ resource, removed: entry.removed }]
                : [];
        }),
    );

    // Set when a whole resource is dropped onto a frame; merging removes it, so ask first.
    let pendingMerge = $state<{
        from: CanvasResource;
        to: CanvasResource;
        service: string;
        restore: Restore;
        landing: { x: number; y: number };
    }>();

    /** Where a dropped card goes back to if its move is cancelled or fails. */
    type Restore = { id: string; position: { x: number; y: number } };

    function restore({ id, position }: Restore) {
        const next = { ...positions, [id]: position };

        positions = next;
        persistLayout(next);
    }

    let moveNotice = $state<{
        message: string;
        warnings: string[];
    }>();

    let moving = $state(false);

    let moveError = $state("");

    // Saves where every card is now: a shift-selection moves several at once.
    function persistCards() {
        const next = { ...positions };

        for (const node of nodes)
            if (node.type === "card") next[node.id] = node.position;

        commit(next);
    }

    function withPositions(list: CanvasNode[], moved: Positions) {
        return refitFrames(
            list.map((node) => {
                const position = moved[node.id];

                return position ? { ...node, position } : node;
            }),
        );
    }

    // Cards never end up on top of each other: the drop settles into the nearest free spot,
    // and a frame that grew into a neighbour moves clear of it with its cards.
    function settleDragged(id: string) {
        let next = withPositions(nodes, settle(nodes, id));
        const card = next.find((node) => node.id === id);

        if (card?.type === "card" && card.data.grouped)
            next = withPositions(
                next,
                settle(next, card.data.resource.id),
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

        const service =
            dragged.type === "card"
                ? dragged.data.service
                : undefined;

        const to = resources.find(
            (resource) => resource.id === target,
        );

        if (
            !target ||
            !to ||
            !service ||
            !startedAt ||
            dragged.type !== "card"
        )
            return;

        const from = dragged.data.resource;
        const back = { id: dragged.id, position: startedAt };

        // Land in the target frame without covering its cards.
        const landing = freeSlot(
            nodeRect(dragged),
            nodes.flatMap((node) =>
                node.type === "card" &&
                node.data.grouped &&
                node.data.resource.id === to.id
                    ? [nodeRect(node)]
                    : [],
            ),
        );

        // A lone card is the whole resource: moving its only service removes it.
        if (!dragged.data.grouped) {
            pendingMerge = {
                from,
                to,
                service: service.name,
                restore: back,
                landing,
            };

            return;
        }

        void moveService(
            from,
            to,
            service.name,
            landing,
            false,
            back,
        );
    }

    async function moveService(
        from: CanvasResource,
        to: CanvasResource,
        service: string,
        droppedAt: { x: number; y: number },
        removeEmptySource: boolean,
        back: Restore,
    ) {
        moving = true;
        moveError = "";

        try {
            const result = await client.resources.moveService({
                projectId,
                fromResourceId: from.id,
                toResourceId: to.id,
                service,
                removeEmptySource,
            });

            // The card keeps the spot it was dropped on under its new id.
            const next = {
                ...positions,
                [`${to.id}:${service}`]: droppedAt,
            };

            positions = next;
            persistLayout(next);
            pendingMerge = undefined;
            moveNotice = {
                message: result.removedResourceId
                    ? `Moved ${service} into ${to.name} and removed ${from.name}. Deploy ${to.name} to start it there.`
                    : `Moved ${service} into ${to.name}. Deploy both to apply it.`,
                warnings: result.warnings,
            };
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
            ]);
        } catch (error) {
            moveError =
                error instanceof Error
                    ? error.message
                    : "The service could not be moved.";

            // A failed merge keeps its dialog open with the error; anything else snaps back.
            if (!pendingMerge) {
                moveNotice = { message: moveError, warnings: [] };
                restore(back);
            }
        } finally {
            moving = false;
        }
    }

    // Cards of a resource's frame, as rectangles.
    function memberRects(resourceId: string) {
        return nodes.flatMap((node) =>
            node.type === "card" &&
            node.data.grouped &&
            node.data.resource.id === resourceId
                ? [nodeRect(node)]
                : [],
        );
    }

    // Frames and lone cards: what a card split out of a frame must not land on.
    function blockRects() {
        return nodes.flatMap((node) =>
            node.type === "stack" || !node.data.grouped
                ? [nodeRect(node)]
                : [],
        );
    }

    // Railway's "Group ›" on a service: into another group, or out into a resource of its own.
    async function regroup(
        nodeId: string,
        toResourceId: string | null,
    ) {
        const node = nodes.find((item) => item.id === nodeId);

        if (node?.type !== "card" || !node.data.service) return;

        const { resource: from, service, grouped } = node.data;

        const back = { id: node.id, position: { ...node.position } };

        if (toResourceId === null) {
            if (grouped) await splitOut([nodeId]);

            return;
        }

        const to = resources.find(
            (resource) => resource.id === toResourceId,
        );

        if (!to || to.id === from.id) return;

        const landing = slotBelow(memberRects(to.id));

        // A lone card is the whole resource: moving its only service removes it, so confirm first.
        if (!grouped) {
            pendingMerge = {
                from,
                to,
                service: service.name,
                restore: back,
                landing,
            };

            return;
        }

        await moveService(
            from,
            to,
            service.name,
            landing,
            false,
            back,
        );
    }

    // Railway's "Remove Group": every service but the first leaves for a resource of its own.
    async function ungroup(resourceId: string) {
        const cards = nodes.filter(
            (node) =>
                node.type === "card" &&
                node.data.grouped &&
                node.data.resource.id === resourceId,
        );

        await splitOut(cards.slice(1).map((node) => node.id));
    }

    // Each card becomes its own resource and lands beside its old frame, clear of everything else.
    async function splitOut(nodeIds: string[]) {
        moving = true;
        moveError = "";

        const placed: Rect[] = [];

        const next = { ...positions };

        const names: string[] = [];

        const warnings: string[] = [];

        try {
            for (const nodeId of nodeIds) {
                const node = nodes.find((item) => item.id === nodeId);

                if (node?.type !== "card" || !node.data.service)
                    continue;

                const frame = frameRect(
                    memberRects(node.data.resource.id),
                );

                const rect = {
                    ...nodeRect(node),
                    x: frame.x + frame.width + COLUMN_GAP,
                };

                const spot = nearestFree(rect, [
                    ...blockRects(),
                    ...placed,
                ]);

                const result = await client.resources.moveService({
                    projectId,
                    fromResourceId: node.data.resource.id,
                    service: node.data.service.name,
                });

                next[result.resourceId] = spot;
                placed.push({ ...rect, ...spot });
                names.push(node.data.service.name);
                warnings.push(...result.warnings);
            }

            moveNotice = {
                message: `Moved ${names.join(", ")} into ${names.length === 1 ? "its own resource" : "resources of their own"}. Deploy to apply it.`,
                warnings,
            };
        } catch (error) {
            moveNotice = {
                message:
                    error instanceof Error
                        ? error.message
                        : "The service could not be moved out.",
                warnings,
            };
        } finally {
            positions = next;
            persistLayout(next);
            moving = false;
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
            ]);
        }
    }

    function resetLayout() {
        commit({});
    }

    function repairLayout() {
        commit({ ...positions, ...repairOverlaps(nodes) });
    }
</script>

<svelte:window
    onkeydown={(event) => {
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

                if (key === "y" || event.shiftKey) redo();
                else undo();

                return;
            }
        }

        // Railway: Escape closes the details panel, unless a dialog or field has focus.
        if (
            event.key !== "Escape" ||
            !selected.current ||
            pendingMerge ||
            add.current ||
            typing
        )
            return;

        select(null);
    }}
/>

<div
    class="project-canvas relative size-full"
    bind:clientWidth={canvasWidth}
>
    <CanvasContextMenu
        {projectId}
        target={menuTarget}
        groups={nodes.flatMap((node) =>
            node.type === "stack"
                ? [{ id: node.id, name: node.data.resource.name }]
                : [],
        )}
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
            snapGrid={[24, 24]}
            defaultEdgeOptions={{
                type: "smoothstep",
                selectable: false,
            }}
            onnodeclick={({ node }) => select(node.id)}
            onpaneclick={() => select(null)}
            onnodecontextmenu={({ node }) =>
                (menuTarget = { kind: "node", nodeId: node.id })}
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
            <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={0.6}
            />
            <CanvasApi bind:toFlow />
            <!-- An empty project has nothing to zoom, undo or add beside the palette, as in Railway. -->
            {#if !empty}
                <Panel position="bottom-left" class="m-4!">
                    <CanvasControls
                        hidden={hidden.current}
                        canUndo={past.length > 0}
                        canRedo={future.length > 0}
                        onlayers={(next) =>
                            void hidden.set(
                                next.length ? next : null,
                            )}
                        onautolayout={resetLayout}
                        onrepair={repairLayout}
                        onundo={undo}
                        onredo={redo}
                    />
                </Panel>
            {/if}
            <CanvasFocus
                nodeId={selectedResource
                    ? (selected.current ?? undefined)
                    : undefined}
                coveredWidth={narrow ? 0 : panelWidth}
            />
        </SvelteFlow>
    </CanvasContextMenu>

    <!-- Stops where the resource panel starts, so notices and actions never sit on top of it. -->
    <div
        class="pointer-events-none absolute inset-y-0 left-0 z-30"
        class:hidden={narrow && selectedResource}
        style:right="{selectedResource ? panelWidth : 0}px"
    >
        {#if !empty}
            <div class="pointer-events-auto absolute top-4 right-4">
                <Button
                    size="sm"
                    variant="outline"
                    class="backdrop-blur-lg"
                    onclick={() => void add.set("root")}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    Add
                </Button>
            </div>
        {/if}
        {#if changes.length && !moveNotice}
            <div
                class="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2"
            >
                <ApplyBar {projectId} {changes} />
            </div>
        {/if}
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

    {#if empty}
        <div
            class="pointer-events-none absolute inset-0 flex items-center justify-center p-4"
        >
            <div class="pointer-events-auto">
                <AddPalette {projectId} inline oncreated={select} />
            </div>
        </div>
    {/if}

    {#if selectedResource}
        {#key selectedResource.id}
            <CanvasPanel
                {clusterId}
                resource={selectedResource}
                services={selectedGraph?.services ?? []}
                {selectedService}
                icon={selectedIcon}
                changed={selectedGraph?.changed ?? false}
                width={panelWidth}
                inset={narrow}
                onclose={() => select(null)}
            />
        {/key}
    {/if}
</div>

{#if !empty}
    <AddPalette {projectId} oncreated={select} />
{/if}

{#if pendingDelete}
    <ConfirmDialog
        bind:open={
            () => pendingDelete !== undefined,
            (open) => {
                if (!open && !deleting) pendingDelete = undefined;
            }
        }
        title={`Delete ${pendingDelete.name}?`}
        description="Its services are removed from the cluster and its deployment history is deleted. Volumes stay on the machines. This cannot be undone."
        confirmLabel="Delete resource"
        pending={deleting}
        error={deleteError}
        onconfirm={() => void deleteResource()}
    />
{/if}

{#if pendingRedeploy}
    <ConfirmDialog
        bind:open={
            () => pendingRedeploy !== undefined,
            (open) => {
                if (!open && !redeploying)
                    pendingRedeploy = undefined;
            }
        }
        title={`Redeploy ${pendingRedeploy.name}?`}
        description="Its containers are recreated from the live configuration, even if nothing changed. Services may be briefly unavailable while they restart."
        confirmLabel="Redeploy"
        pending={redeploying}
        error={redeployError}
        onconfirm={() => void redeployResource()}
    />
{/if}

<GroupDialogs
    {projectId}
    resource={editing.resource}
    action={editing.action}
    onclose={() => void edit.set(null)}
/>

{#if pendingMerge}
    <ConfirmDialog
        bind:open={
            () => pendingMerge !== undefined,
            (open) => {
                if (open || !pendingMerge || moving) return;

                // Cancelled: the card goes back where the drag started.
                restore(pendingMerge.restore);
                pendingMerge = undefined;
                moveError = "";
            }
        }
        title={`Move ${pendingMerge.from.name} into ${pendingMerge.to.name}?`}
        description={`Its service moves into the Compose draft of ${pendingMerge.to.name}, and ${pendingMerge.from.name} is removed now, stopping its containers. Volumes keep their data and stay on the machines. Deploy ${pendingMerge.to.name} to start the service there.`}
        confirmLabel="Move and remove"
        pending={moving}
        error={moveError}
        onconfirm={() => {
            if (!pendingMerge) return;

            const {
                from,
                to,
                service,
                restore: back,
                landing,
            } = pendingMerge;

            void moveService(from, to, service, landing, true, back);
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
        --xy-background-pattern-dots-color: color-mix(
            in oklab,
            var(--muted-foreground) 70%,
            transparent
        );
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
