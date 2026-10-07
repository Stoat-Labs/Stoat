<!--
@component
Storage bucket in Lucide's style (24px grid, 2px round strokes). Lucide only
ships `paint-bucket`, so this renders through Lucide's own `Icon` and takes the
same props as any `@lucide/svelte` icon.
-->
<script lang="ts">
    import {
        Icon,
        type LucideIconNode,
        type LucideProps,
    } from "@lucide/svelte";

    let props: LucideProps = $props();

    const iconNode: LucideIconNode[] = [
        ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }],
        ["path", { d: "M3 5l2 14a7 3 0 0 0 14 0l2-14" }],
    ];
</script>

<Icon {...props} {iconNode} />
