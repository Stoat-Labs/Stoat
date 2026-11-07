<script lang="ts">
    import CheckIcon from "phosphor-svelte/lib/CheckIcon";
    import MinusIcon from "phosphor-svelte/lib/MinusIcon";
    import { Checkbox as CheckboxPrimitive } from "@shardsui/svelte/checkbox";
    import type { ComponentProps } from "svelte";
    import { cn } from "$lib/utils.js";

    let {
        checked = $bindable(false),
        class: className,
        indeterminate = false,
        ref = $bindable(null),
        ...restProps
    }: ComponentProps<typeof CheckboxPrimitive.Root> = $props();
</script>

<CheckboxPrimitive.Root
    bind:ref
    bind:checked
    {indeterminate}
    class={cn(
        "relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none ring-ring transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 data-disabled:cursor-not-allowed data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none",
        className,
    )}
    data-slot="checkbox"
    {...restProps}
>
    {#snippet children({ checked, indeterminate })}
        <span
            class="absolute -inset-px flex items-center justify-center rounded-[.25rem] text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground"
            data-slot="checkbox-indicator"
            data-checked={checked ? "" : undefined}
            data-unchecked={!checked && !indeterminate
                ? ""
                : undefined}
            data-indeterminate={indeterminate ? "" : undefined}
        >
            {#if indeterminate}
                <MinusIcon
                    class="size-3.5 sm:size-3"
                    aria-hidden="true"
                />
            {:else if checked}
                <CheckIcon
                    class="size-3.5 sm:size-3"
                    aria-hidden="true"
                />
            {/if}
        </span>
    {/snippet}
</CheckboxPrimitive.Root>
