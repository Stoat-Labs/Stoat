<script lang="ts">
    import type { ComponentProps } from "svelte";
    import { Select as SelectPrimitive } from "@shardsui/svelte/select";

    type SelectItemDef = { label: string; value: string };

    let {
        value = $bindable(),
        items = [],
        ...restProps
    }: Omit<
        ComponentProps<typeof SelectPrimitive.Root>,
        "value" | "items"
    > & {
        value?: string | string[];
        items?: SelectItemDef[];
    } = $props();
</script>

<SelectPrimitive.Root
    bind:value={value as never}
    {items}
    {...restProps}
/>
