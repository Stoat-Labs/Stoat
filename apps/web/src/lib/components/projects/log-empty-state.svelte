<script lang="ts">
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyTitle,
    } from "$lib/components/ui/empty";

    let {
        hasServices,
        mode,
        searched,
        pending,
    }: {
        hasServices: boolean;
        mode: "live" | "search";
        searched: boolean;
        pending: boolean;
    } = $props();
</script>

{#if !hasServices}
    <Empty class="h-full">
        <EmptyHeader>
            <EmptyTitle>Select a service</EmptyTitle><EmptyDescription
            >
                Choose one or more services to view their logs.
            </EmptyDescription>
        </EmptyHeader>
    </Empty>
{:else if mode === "search" && !searched && !pending}
    <Empty class="h-full">
        <EmptyHeader>
            <EmptyTitle>
                Search stored logs
            </EmptyTitle><EmptyDescription>
                Choose a time range and search. Leave the message
                field empty to see all logs.
            </EmptyDescription>
        </EmptyHeader>
    </Empty>
{:else}
    <Empty class="h-full">
        <EmptyHeader>
            <EmptyTitle>
                {pending
                    ? "Searching logs..."
                    : mode === "live"
                      ? "Waiting for logs"
                      : "No matching logs"}
            </EmptyTitle><EmptyDescription>
                {mode === "live"
                    ? "New output from selected services appears here."
                    : "Try a wider time range, different services, or a shorter search."}
            </EmptyDescription>
        </EmptyHeader>
    </Empty>
{/if}
