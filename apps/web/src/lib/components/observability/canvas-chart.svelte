<script
    lang="ts"
    generics="TDatum, TXValue extends ChartValue = ChartValue, TYValue extends ChartValue = ChartValue"
>
    import type { ChartValue } from "@tanstack/charts";
    import {
        mountCanvasChart,
        type CanvasChartHost,
        type CanvasChartHostOptions,
    } from "@tanstack/charts/canvas";
    import { onMount } from "svelte";

    // TanStack's Svelte adapter is SVG-only, so this mounts the Canvas host directly.
    // Canvas has no server output; the chart paints once the browser mounts it.
    let {
        class: className,
        ...options
    }: CanvasChartHostOptions<TDatum, TXValue, TYValue> & {
        class?: string;
    } = $props();

    let container: HTMLDivElement;

    let host: CanvasChartHost<TDatum, TXValue, TYValue> | undefined;

    onMount(() => {
        host = mountCanvasChart(container, { ...options });

        return () => host?.destroy();
    });

    $effect(() => {
        host?.update({ ...options });
    });
</script>

<div bind:this={container} class={className}></div>
