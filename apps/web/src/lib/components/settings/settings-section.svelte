<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        description,
        count,
        actions,
        children,
    }: {
        title: string;
        description: string;
        count?: string;
        actions?: Snippet;
        children: Snippet;
    } = $props();

    const headingId = $props.id();
</script>

<section class="space-y-4" aria-labelledby={headingId}>
    <header
        class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3"
    >
        <div class="min-w-0">
            <div class="flex flex-wrap items-baseline gap-2">
                <h2
                    id={headingId}
                    class="text-lg font-semibold leading-tight tracking-tight"
                >
                    {title}
                </h2>
                {#if count}
                    <span
                        class="text-xs tabular-nums text-muted-foreground"
                    >
                        {count}
                    </span>
                {/if}
            </div>
            <p class="mt-1 text-sm text-muted-foreground">
                {description}
            </p>
        </div>
        {#if actions}
            <div class="flex flex-wrap items-center gap-2">
                {@render actions()}
            </div>
        {/if}
    </header>
    {@render children()}
</section>
