<script lang="ts">
    import LoaderCircle from "phosphor-svelte/lib/CircleNotchIcon";
    import type { ComponentProps } from "svelte";
    import { cn } from "$lib/utils";

    let {
        class: className,
        ...restProps
    }: ComponentProps<typeof LoaderCircle> = $props();
</script>

<LoaderCircle
    aria-label="Loading"
    class={cn("animate-spin", className)}
    role="status"
    {...restProps}
/>
