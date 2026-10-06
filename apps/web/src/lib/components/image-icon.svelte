<script lang="ts">
    import { imageIcon } from "$lib/image-icons";
    import Box from "@lucide/svelte/icons/box";

    let { image }: { image: string | null | undefined } = $props();

    const icon = $derived(imageIcon(image));
</script>

{#if icon}
    <img
        src={icon}
        alt=""
        aria-hidden="true"
        class="size-10 shrink-0 object-contain p-1"
    />
{:else}
    <span
        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
        <Box class="size-5" aria-hidden="true" />
    </span>
{/if}
