<script lang="ts">
    import {
        useNodesInitialized,
        useStore,
        useSvelteFlow,
    } from "@xyflow/svelte";
    import type { Viewport } from "@xyflow/svelte";
    import { untrack } from "svelte";

    let {
        nodeId,
        coveredWidth,
    }: {
        /** The node the details panel is open for, if any. */
        nodeId: string | undefined;
        /** Pixels of the canvas hidden behind the panel on the right. */
        coveredWidth: number;
    } = $props();

    const glide = 250;

    // Only usable inside <SvelteFlow>, which is why this lives in its own component.
    const flow = useSvelteFlow();

    const initialized = useNodesInitialized();

    const store = useStore();

    // The zoom controls float over the bottom-left corner: 36px wide, 16px from the edge.
    const controlsWidth = 64;

    const padding = 48;

    // Below this the cards are too small to read, so a bigger graph centres the opened card instead.
    const minFitZoom = 0.5;

    // Live refetches rebuild the nodes; only a newly opened node moves the camera.
    let focused: string | undefined;

    // Where the camera was before the panel opened, so closing it glides back there like Railway.
    let before: Viewport | undefined;

    // Glide to the opened node and centre it in the part of the canvas the panel leaves visible.
    $effect(() => {
        // Closing the panel lets the same node glide into focus again next time.
        if (!nodeId) {
            focused = undefined;

            if (before) {
                void flow.setViewport(before, { duration: glide });
                before = undefined;
            }
        }

        // Wait for the canvas width too, or a deep link centres the node behind the panel.
        if (
            !nodeId ||
            !initialized.current ||
            coveredWidth <= 0 ||
            nodeId === focused
        )
            return;

        const id = nodeId;
        const covered = coveredWidth;

        // Untracked: reading the viewport here must not re-run this on every pan or zoom.
        untrack(() => focus(id, covered));
    });

    function focus(id: string, covered: number) {
        const node = flow.getInternalNode(id);

        if (!node) return;

        focused = id;
        before ??= flow.getViewport();

        if (fitBeside(covered)) return;

        const { x, y } = node.internals.positionAbsolute;
        const width = node.measured.width ?? node.width ?? 0;
        const height = node.measured.height ?? node.height ?? 0;
        // Keep the zoom the user chose, but never zoom in past 100% like Railway.
        const zoom = Math.min(flow.getZoom(), 1);
        // Shifting the camera right by half the covered width moves the node left by as much.
        const offset = covered / 2 / zoom;

        void flow.setCenter(x + width / 2 + offset, y + height / 2, {
            zoom,
            duration: glide,
        });
    }

    // Shows the whole graph in the canvas the panel leaves visible, when it fits at a readable zoom.
    function fitBeside(covered: number) {
        const bounds = flow.getNodesBounds(flow.getNodes());

        const width =
            store.width - covered - controlsWidth - padding * 2;

        const height = store.height - padding * 2;

        // Never zoom in past the zoom the user chose, or past 100% like Railway.
        const zoom = Math.min(
            flow.getZoom(),
            1,
            width / bounds.width,
            height / bounds.height,
        );

        if (!(zoom >= minFitZoom)) return false;

        void flow.setViewport(
            {
                x:
                    controlsWidth +
                    padding +
                    (width - bounds.width * zoom) / 2 -
                    bounds.x * zoom,
                y:
                    padding +
                    (height - bounds.height * zoom) / 2 -
                    bounds.y * zoom,
                zoom,
            },
            { duration: glide },
        );

        return true;
    }
</script>
