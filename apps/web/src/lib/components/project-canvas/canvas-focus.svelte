<script lang="ts">
    import {
        useNodesInitialized,
        useSvelteFlow,
    } from "@xyflow/svelte";
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

    // Only usable inside <SvelteFlow>, which is why this lives in its own component.
    const flow = useSvelteFlow();

    const initialized = useNodesInitialized();

    // Live refetches rebuild the nodes; only a newly opened node moves the camera.
    let focused: string | undefined;

    // Glide to the opened node and centre it in the part of the canvas the panel leaves visible.
    $effect(() => {
        // Closing the panel lets the same node glide into focus again next time.
        if (!nodeId) focused = undefined;

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

        const { x, y } = node.internals.positionAbsolute;
        const width = node.measured.width ?? node.width ?? 0;
        const height = node.measured.height ?? node.height ?? 0;
        // Keep the zoom the user chose, but never zoom in past 100% like Railway.
        const zoom = Math.min(flow.getZoom(), 1);
        // Shifting the camera right by half the covered width moves the node left by as much.
        const offset = covered / 2 / zoom;

        void flow.setCenter(x + width / 2 + offset, y + height / 2, {
            zoom,
            duration: 450,
        });
    }
</script>
