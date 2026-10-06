<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import type { Snippet } from "svelte";

    let {
        label,
        value,
        mono = false,
        copyable = false,
        inline = false,
        children,
    }: {
        label: string;
        value?: string;
        mono?: boolean;
        copyable?: boolean;
        inline?: boolean;
        children?: Snippet;
    } = $props();

    let copied = $state(false);

    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    async function copy() {
        if (!value) return;

        try {
            await navigator.clipboard.writeText(value);
        } catch {
            // Leave the value selectable without claiming a failed copy succeeded.
            return;
        }

        copied = true;

        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => (copied = false), 1500);
    }
</script>

<div
    class={[
        "flex min-w-0 gap-3 px-3 py-2",
        inline ? "items-center justify-between" : "items-start",
    ]}
>
    <div
        class={[
            "min-w-0",
            inline
                ? "flex flex-1 items-center justify-between gap-3"
                : "flex-1",
        ]}
    >
        <dt class="shrink-0 text-sm leading-5 font-medium">
            {label}
        </dt>
        <dd
            class={[
                "min-w-0 truncate text-sm leading-5 text-muted-foreground",
                !inline && "mt-1",
                mono && "font-mono",
            ]}
            title={value}
        >
            {#if children}
                {@render children()}
            {:else}
                {value}
            {/if}
        </dd>
    </div>
    {#if copyable}
        <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0"
            onclick={copy}
            aria-label={`Copy ${label.toLowerCase()}`}
            title={`Copy ${label.toLowerCase()}`}
        >
            {#if copied}
                <Check
                    class="text-success-foreground"
                    aria-hidden="true"
                />
            {:else}
                <Copy aria-hidden="true" />
            {/if}
        </Button>
    {/if}
</div>
