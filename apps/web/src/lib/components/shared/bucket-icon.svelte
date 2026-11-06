<!--
@component
Storage bucket in Phosphor's style (256 grid, round strokes), which Phosphor doesn't ship.
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
    <ellipse cx="128" cy="60" rx="92" ry="32" />
    <path
        d="M36 60l20 140c0 17.700 32.200 32 72 32s72-14.300 72-32l20-140"
    />
</svg>
