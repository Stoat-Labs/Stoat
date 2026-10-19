<!-- One resource on a project's preview: its logo in a small card, like a node on the canvas. -->
<script lang="ts">
    import { imageIcon } from "$lib/resources/image-icons";
    import Box from "@lucide/svelte/icons/box";
    import Database from "@lucide/svelte/icons/database";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import type { ProjectCardResource } from "./project-card.svelte";

    let {
        resource,
        size = "md",
    }: {
        resource: ProjectCardResource;
        size?: "sm" | "md";
    } = $props();

    // An uploaded or template icon wins, then a known image, then the resource's kind.
    const src = $derived(resource.icon ?? imageIcon(resource.image));

    const glyph = $derived(size === "sm" ? "size-3.5" : "size-4.5");
</script>

<li
    class={[
        "flex shrink-0 items-center justify-center border bg-card text-foreground shadow-xs/5",
        size === "sm" ? "size-7 rounded-md" : "size-10 rounded-lg",
    ]}
    title={resource.name}
>
    {#if src}
        <img
            {src}
            alt=""
            class={[
                "object-contain",
                size === "sm" ? "size-4" : "size-5",
            ]}
        />
    {:else if resource.type === "bucket"}
        <HardDrive class={glyph} aria-hidden="true" />
    {:else if resource.type === "database"}
        <Database class={glyph} aria-hidden="true" />
    {:else}
        <Box class={glyph} aria-hidden="true" />
    {/if}
    <span class="sr-only">{resource.name}</span>
</li>
