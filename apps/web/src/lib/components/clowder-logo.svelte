<script lang="ts">
    import type { SVGAttributes } from "svelte/elements";

    let {
        color = "currentColor",
        ...rest
    }: {
        /** Any CSS color: "#abe841", "currentColor" or "var(--primary)". */
        color?: string;
    } & SVGAttributes<SVGSVGElement> = $props();
</script>

<!-- Same path as static/clowder.svg. Fill goes through style so var() works; the fill attribute ignores it. -->
<svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="4 4 56 56"
    role="img"
    aria-label="Clowder"
    {...rest}
>
    <path
        style:fill={color}
        d="M16.17 8.9A28 28 0 0 0 34.72 59.87A38.25 38.25 0 0 1 16.17 8.9ZM23.49 5.33A33.75 33.75 0 0 0 42.62 57.91A28 28 0 0 0 51.55 52.05A38.25 38.25 0 0 1 34.09 4.08A28 28 0 0 0 23.49 5.33ZM38.66 4.8A33.75 33.75 0 0 0 54.58 48.55A28 28 0 0 0 38.66 4.8Z"
    />
</svg>
