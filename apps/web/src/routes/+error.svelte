<script lang="ts">
    import { page } from "$app/state";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

    const notFound = $derived(page.status === 404);
</script>

<svelte:head>
    <title>{notFound ? "Not found" : "Error"} / Stoat</title>
</svelte:head>

<div
    class="flex min-h-[60svh] w-full items-center justify-center p-6"
>
    <Empty>
        <EmptyHeader>
            <EmptyMedia variant="icon">
                <TriangleAlert aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
                {notFound ? "Page not found" : "Something went wrong"}
            </EmptyTitle>
            <EmptyDescription>
                {notFound
                    ? "It may have moved or been deleted."
                    : (page.error?.message ??
                      "An unexpected error stopped this page from loading.")}
            </EmptyDescription>
        </EmptyHeader>
        <EmptyContent class="flex-row justify-center">
            {#if !notFound}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={() => location.reload()}
                >
                    Try again
                </Button>
            {/if}
            <Button size="sm" href="/">
                <ArrowLeft class="size-4" aria-hidden="true" />
                Back to home
            </Button>
        </EmptyContent>
    </Empty>
</div>
