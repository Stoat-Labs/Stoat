<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";

    let {
        live,
        streamError,
        reconnecting,
        failures,
        searchError,
    }: {
        live: boolean;
        streamError: string;
        reconnecting: boolean;
        /** Per-service stream problems, already resolved to display names. */
        failures: {
            id: string;
            name: string | undefined;
            message?: string;
        }[];
        searchError: string;
    } = $props();
</script>

<!-- A stream that is still retrying warns through LogStream's toast instead. -->
{#if streamError && live && !reconnecting}
    <Alert variant="error" class="m-2 shrink-0 px-3 py-2">
        <AlertDescription>{streamError}</AlertDescription>
    </Alert>
{/if}
{#if live && failures.length}
    <div
        class="shrink-0 border-b px-3 py-2 text-xs text-warning-foreground"
        role="status"
    >
        {#each failures as failure (failure.id)}<p>
                {failure.name}: {failure.message ??
                    "Stream unavailable. Reconnect to retry."}
            </p>{/each}
    </div>
{/if}
{#if searchError}<Alert
        variant="error"
        class="m-2 shrink-0 px-3 py-2"
    >
        <AlertDescription>{searchError}</AlertDescription>
    </Alert>{/if}
