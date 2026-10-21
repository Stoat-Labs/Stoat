<script lang="ts">
    import "@aejkatappaja/phantom-ui";
    import "@aejkatappaja/phantom-ui/ssr.css";
    import { type PhantomUiAttributes } from "@aejkatappaja/phantom-ui";
    import type { Snippet } from "svelte";

    let {
        children,
        ...restProps
    }: PhantomUiAttributes & {
        children: Snippet;
    } = $props();
</script>

<phantom-ui data-slot="skeleton" {...restProps}>
    {@render children?.()}
</phantom-ui>

<style>
    /* Until phantom-ui's script defines the element, ssr.css hides the content but draws no blocks.
       Paint each leaf like phantom-ui's default block; :where keeps it below the leaf's own classes. */
    :global(
        :where(phantom-ui[loading]:not(:defined))
            :where(:not(:has(*)):not([data-shimmer-ignore]))
    ) {
        background: rgba(128, 128, 128, 0.2);
        border-radius: 4px;
    }
</style>
