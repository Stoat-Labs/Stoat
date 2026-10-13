<script lang="ts">
    import "@xyflow/svelte/dist/style.css";
    import {
        Background,
        BackgroundVariant,
        ConnectionMode,
        MarkerType,
        Panel,
        SvelteFlow,
        type Edge,
        type NodeTypes,
    } from "@xyflow/svelte";
    import { Button } from "$lib/components/ui/button";
    import Plus from "@lucide/svelte/icons/plus";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";
    import { onMount, untrack } from "svelte";
    import AddPalette, { addPages } from "./add-palette.svelte";
    import CanvasContextMenu, {
        type MenuTarget,
        type PanelTab,
    } from "./canvas-context-menu.svelte";
    import CanvasFocus from "./canvas-focus.svelte";
    import CanvasPanel from "./canvas-panel.svelte";
    import CanvasControls from "./canvas-controls.svelte";
    import CardNode from "./card-node.svelte";
    import { setCanvasClock } from "./context";
    import {
        buildCanvas,
        clearPositions,
        loadPositions,
        savePositions,
        type CanvasGraph,
        type CanvasLogos,
        type CanvasNode,
        type CanvasResource,
        type Positions,
    } from "./graph";
    import StackNode from "./stack-node.svelte";

    let {
        projectId,
        clusterId,
        resources,
        graph,
        logos,
    }: {
        projectId: string;
        clusterId: string;
        resources: CanvasResource[];
        graph: CanvasGraph;
        logos: CanvasLogos;
    } = $props();

    const nodeTypes: NodeTypes = { card: CardNode, stack: StackNode };

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

    function select(nodeId: string | null) {
        if (nodeId === selected.current) return;

        void deployment.set(null);
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

    // Runs before the build effect, so the first render already uses the saved layout.
    $effect.pre(() => {
        positions = loadPositions(projectId);
    });

    let nodes = $state.raw<CanvasNode[]>([]);

    let edges = $state.raw<Edge[]>([]);

    // Live status refetches rebuild the graph; dragged positions survive through `positions`.
    // Selection comes from the URL so a shared link highlights the same card.
    $effect(() => {
        const built = buildCanvas(resources, graph, logos, positions);

        nodes = built.nodes.map((node) => ({
            ...node,
            selected: node.id === selected.current,
        }));
        // Railway highlights the selected card's connections; a selected group lights its own too.
        edges = built.edges.map((edge) => {
            const active = [edge.source, edge.target].some(
                (id) =>
                    id === selected.current ||
                    id.startsWith(`${selected.current}:`),
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
    });

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

    // Railway docks its panel flush right at about two thirds of the canvas, 1008px at most.
    const panelWidth = $derived(
        Math.min(1008, Math.round(canvasWidth * 0.645)),
    );

    function resetLayout() {
        clearPositions(projectId);
        positions = {};
    }
</script>

<div
    class="project-canvas relative size-full"
    bind:clientWidth={canvasWidth}
>
    <CanvasContextMenu
        {projectId}
        target={menuTarget}
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
            minZoom={0.2}
            maxZoom={1.5}
            defaultEdgeOptions={{
                type: "smoothstep",
                selectable: false,
            }}
            onnodeclick={({ node }) => select(node.id)}
            onpaneclick={() => select(null)}
            onnodecontextmenu={({ node }) =>
                (menuTarget = { kind: "node", nodeId: node.id })}
            onpanecontextmenu={() => (menuTarget = { kind: "pane" })}
            onnodedragstop={({ nodes: dragged }) => {
                const next = { ...positions };

                for (const node of dragged)
                    if (!node.parentId) next[node.id] = node.position;

                positions = next;
                savePositions(projectId, next);
            }}
        >
            <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={0.6}
            />
            <Panel position="bottom-left" class="m-4!">
                <CanvasControls onreset={resetLayout} />
            </Panel>
            <CanvasFocus
                nodeId={selectedResource
                    ? (selected.current ?? undefined)
                    : undefined}
                coveredWidth={panelWidth}
            />
            <Panel position="top-right" class="m-4!">
                <Button
                    size="sm"
                    variant="outline"
                    class="bg-card"
                    onclick={() => void add.set("root")}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    Add
                </Button>
            </Panel>
        </SvelteFlow>
    </CanvasContextMenu>

    {#if selectedResource}
        {#key selectedResource.id}
            <CanvasPanel
                {clusterId}
                resource={selectedResource}
                services={selectedGraph?.services ?? []}
                {selectedService}
                icon={selectedIcon}
                width={panelWidth}
                onclose={() => select(null)}
            />
        {/key}
    {/if}
</div>

<AddPalette {projectId} />

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
