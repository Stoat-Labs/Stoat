<script lang="ts">
    import { useSvelteFlow } from "@xyflow/svelte";

    let {
        toFlow = $bindable(),
    }: {
        /** Screen point to canvas coordinates; only callable from inside <SvelteFlow>. */
        toFlow?: (point: { x: number; y: number }) => {
            x: number;
            y: number;
        };
    } = $props();

    const flow = useSvelteFlow();

    toFlow = (point) => flow.screenToFlowPosition(point);
</script>
