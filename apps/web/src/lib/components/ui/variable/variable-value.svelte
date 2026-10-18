<!-- Railway's masked value, with reveal and copy on hover. -->
<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import Copy from "@lucide/svelte/icons/copy";
    import Eye from "@lucide/svelte/icons/eye";
    import EyeOff from "@lucide/svelte/icons/eye-off";

    let {
        name,
        value,
        visible,
        disabled = false,
        ontoggle,
        oncopy,
    }: {
        name: string;
        /** Shown while `visible`; `undefined` until it is loaded. */
        value: string | undefined;
        visible: boolean;
        disabled?: boolean;
        ontoggle: () => void;
        oncopy: () => void;
    } = $props();
</script>

<div class="flex min-w-0 items-center gap-2">
    <span
        class="min-w-0 truncate font-mono text-sm"
        title={visible ? value : undefined}
    >
        {visible ? value || "(empty)" : "*******"}
    </span>
    <span
        class="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
    >
        <Button
            size="icon-xs"
            variant="ghost"
            aria-label={visible ? `Hide ${name}` : `Show ${name}`}
            {disabled}
            onclick={ontoggle}
        >
            {#if visible}
                <EyeOff class="size-4" aria-hidden="true" />
            {:else}
                <Eye class="size-4" aria-hidden="true" />
            {/if}
        </Button>
        <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy {name}"
            {disabled}
            onclick={oncopy}
        >
            <Copy class="size-4" aria-hidden="true" />
        </Button>
    </span>
</div>
