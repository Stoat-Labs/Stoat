<script lang="ts">
    import { useStore } from "@xyflow/svelte";
    import { devicePixelRatio } from "svelte/reactivity/window";
    import { gridDots, SNAP_GRID } from "./graph";

    const store = $derived(useStore());

    const scale = $derived(devicePixelRatio.current ?? 1);

    const width = $derived(Math.round(store.width * scale));

    const height = $derived(Math.round(store.height * scale));

    function draw(canvas: HTMLCanvasElement) {
        const context = canvas.getContext("2d");

        if (!context) return;

        const { x, y, zoom } = store.viewport;

        const gap = SNAP_GRID * zoom * scale;

        const size = Math.max(1, Math.round(scale));

        const columns = gridDots(x * scale, gap, width);

        const rows = gridDots(y * scale, gap, height);

        context.clearRect(0, 0, width, height);

        for (const row of rows) {
            for (const column of columns) {
                context.fillRect(column, row, size, size);
            }
        }
    }
</script>

<!-- Canvas, not Background's SVG pattern: a sub-pixel dot's brightness depends on where it lands, so every dot here fills whole device pixels. -->
<div class="svelte-flow__background svelte-flow__container">
    <!-- Dots are drawn black and tinted here, so a theme switch needs no redraw; pixelated stops fractional browser zoom blurring them. -->
    <canvas
        {width}
        {height}
        class="opacity-14 [image-rendering:pixelated] dark:invert"
        style:width="{width / scale}px"
        style:height="{height / scale}px"
        {@attach draw}
    ></canvas>
</div>
