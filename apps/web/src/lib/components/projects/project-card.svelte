<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import {
        Card,
        CardDescription,
        CardFooter,
        CardHeader,
        CardTitle,
    } from "$lib/components/ui/card";
    import LayoutGrid from "@lucide/svelte/icons/layout-grid";

    let {
        name,
        description,
        resourceCount = 0,
        clusterName,
        href,
    }: {
        name: string;
        description?: string | null;
        resourceCount?: number;
        clusterName?: string;
        href?: string;
    } = $props();
</script>

<Card
    class="group h-full min-w-0 gap-0 p-4 transition-colors hover:border-input"
    data-slot="project-card"
>
    <CardHeader class="min-h-9 space-y-0 p-0">
        <div class="flex items-center gap-3">
            <span
                class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50"
                aria-hidden="true"
            >
                <LayoutGrid class="size-4 text-muted-foreground" />
            </span>
            <span class="min-w-0">
                <CardTitle
                    class="block truncate text-[15px] leading-tight"
                >
                    {#if href}
                        <a
                            {href}
                            class="before:absolute before:inset-0 before:rounded-2xl group-hover:underline focus-visible:outline-none focus-visible:before:ring-2 focus-visible:before:ring-ring"
                        >
                            {name}
                        </a>
                    {:else}
                        {name}
                    {/if}
                </CardTitle>
                {#if description?.trim()}
                    <CardDescription class="mt-0.5 block truncate">
                        {description}
                    </CardDescription>
                {/if}
            </span>
        </div>
    </CardHeader>

    <CardFooter
        class="mt-auto items-center justify-between gap-2 p-0 pt-5"
    >
        <p class="flex shrink-0 items-center gap-1.5">
            <Badge variant="secondary">
                {resourceCount}
                {resourceCount === 1 ? "resource" : "resources"}
            </Badge>
        </p>
        {#if clusterName}
            <span
                class="truncate text-xs text-muted-foreground"
                title={clusterName}
            >
                {clusterName}
            </span>
        {/if}
    </CardFooter>
</Card>
