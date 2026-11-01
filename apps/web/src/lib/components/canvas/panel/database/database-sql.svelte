<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import Play from "@lucide/svelte/icons/play";
    import { createMutation } from "@tanstack/svelte-query";
    import DatabaseGrid from "./database-grid.svelte";
    import type { DatabaseInput } from "./query";

    let {
        input,
        sql = $bindable(),
        onrun,
    }: {
        input: DatabaseInput;
        sql: string;
        /** The SQL may have created, changed or dropped a table. */
        onrun: () => void;
    } = $props();

    const run = createMutation(() =>
        orpc.resources.queryPostgres.mutationOptions({
            onSuccess: onrun,
        }),
    );

    const columns = $derived(
        run.data?.columns.map((name, index) => ({ name, index })) ??
            [],
    );
</script>

<div class="flex h-full min-h-0 flex-col">
    <div class="border-b bg-code dark:bg-black/20">
        <CodeEditor
            bind:value={sql}
            language="text"
            label="SQL query"
        />
    </div>
    <div class="flex items-center gap-3 border-b px-4 py-2">
        <Button
            size="sm"
            loading={run.isPending}
            onclick={() => run.mutate({ ...input, query: sql })}
        >
            <Play aria-hidden="true" />
            Run
        </Button>
        {#if run.data}
            <p class="text-xs text-muted-foreground" role="status">
                {run.data.command}
            </p>
        {/if}
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
        {#if run.error}
            <Alert variant="error" class="m-4 w-auto">
                <!-- PostgreSQL's caret lines up only in monospace with line breaks kept. -->
                <AlertDescription
                    class="font-mono text-xs whitespace-pre-wrap"
                >
                    {run.error.message}
                </AlertDescription>
            </Alert>
        {:else if run.data && columns.length > 0}
            <DatabaseGrid {columns} rows={run.data.rows} />
        {/if}
    </div>
</div>
