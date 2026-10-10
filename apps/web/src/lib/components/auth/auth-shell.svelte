<script lang="ts">
    import type { Snippet } from "svelte";

    // The centered single-column layout shared by login, sign-up and first-run setup.
    let {
        title,
        description,
        eyebrow,
        wide = false,
        children,
        footer,
    }: {
        title: string;
        description: string;
        /** A short line above the title, such as "Step 2 of 3". */
        eyebrow?: string;
        wide?: boolean;
        children: Snippet;
        footer?: Snippet;
    } = $props();
</script>

<main
    class={[
        "relative mx-auto flex min-h-svh w-full flex-col justify-center gap-8 bg-background p-6 md:p-8",
        wide ? "max-w-md" : "max-w-sm",
    ]}
>
    <div
        class="flex flex-col gap-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-600"
    >
        <div class="flex flex-row items-center justify-between gap-4">
            <a
                href="/"
                class="flex w-fit shrink-0 items-center gap-2"
                aria-label="Stoat home"
            >
                <img src="/stoat.png" alt="" height="80" width="80" />
            </a>
            <div class="flex flex-col gap-1">
                {#if eyebrow}
                    <p class="text-sm text-muted-foreground">
                        {eyebrow}
                    </p>
                {/if}
                <h1 class="text-2xl font-bold tracking-wide">
                    {title}
                </h1>
                <p class="text-base text-muted-foreground">
                    {description}
                </p>
            </div>
        </div>
        {@render children()}
    </div>
    {@render footer?.()}
</main>
