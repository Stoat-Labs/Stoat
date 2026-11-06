<!--
@component
Hard drive in Phosphor's style (256 grid, round strokes). Phosphor's own is a flat
rectangle that reads as nothing at 16px.
-->
<script lang="ts">
    import type { SVGAttributes } from "svelte/elements";

    let {
        weight = "bold",
        ...props
    }: SVGAttributes<SVGSVGElement> & {
        weight?: "regular" | "bold";
    } = $props();
</script>

<svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 256 256"
    fill="none"
    stroke="currentColor"
    stroke-width={weight === "bold" ? 24 : 16}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    {...props}
>
    <path
        d="M40 136 72 56a16 16 0 0 1 15-10h82a16 16 0 0 1 15 10l32 80"
    />
    <path
        d="M40 136h176v64a16 16 0 0 1-16 16H56a16 16 0 0 1-16-16Z"
    />
    <circle
        cx="176"
        cy="176"
        r="16"
        fill="currentColor"
        stroke="none"
    />
</svg>
