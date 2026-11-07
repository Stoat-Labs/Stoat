<!--
@component
Text wrapping in Phosphor's style (256 grid, round strokes), which Phosphor doesn't ship.
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
    <path d="M40 64h176" />
    <path d="M40 128h148a28 28 0 0 1 0 56h-68" />
    <path d="M144 160l-24 24 24 24" />
    <path d="M40 192h40" />
</svg>
