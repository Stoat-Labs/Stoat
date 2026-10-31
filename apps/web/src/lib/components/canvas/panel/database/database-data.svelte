<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import Play from "@lucide/svelte/icons/play";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        quoteIdent,
        sqlQuery,
        type DatabaseInput,
    } from "./query";

    let { input }: { input: DatabaseInput } = $props();

    const tables = createQuery(() =>
        sqlQuery(
            input,
            `SELECT table_schema, table_name FROM information_schema.tables
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
             ORDER BY table_schema, table_name`,
        ),
    );

    let sql = $state("SELECT now();");

    const run = createMutation(() =>
        orpc.resources.queryPostgres.mutationOptions({
            // The SQL may have created or dropped a table.
            onSuccess: () => void tables.refetch(),
        }),
    );

    function execute() {
        run.mutate({ ...input, query: sql });
    }

    function open(schema: string, table: string) {
        sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT 100;`;
        execute();
    }
</script>

<div class="flex min-h-full gap-6">
    <nav class="w-48 shrink-0" aria-label="Tables">
        <p class="mb-3 text-sm text-muted-foreground">Tables</p>
        {#if tables.isPending}
            <Skeleton loading label="Loading tables">
                <div class="space-y-2">
                    <p class="text-sm">users</p>
                    <p class="text-sm">sessions</p>
                    <p class="text-sm">accounts</p>
                </div>
            </Skeleton>
        {:else if tables.isError}
            <p class="text-sm text-destructive-foreground">
                {tables.error.message}
            </p>
        {:else}
            <ul class="space-y-1">
                {#each tables.data.rows as [schema, table] (`${schema}.${table}`)}
                    <li>
                        <button
                            type="button"
                            class="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                            onclick={() =>
                                open(schema ?? "", table ?? "")}
                        >
                            {schema === "public"
                                ? table
                                : `${schema}.${table}`}
                        </button>
                    </li>
                {:else}
                    <li class="text-sm text-muted-foreground">
                        No tables yet.
                    </li>
                {/each}
            </ul>
        {/if}
    </nav>

    <div class="flex min-w-0 flex-1 flex-col gap-4">
        <div
            class="overflow-hidden rounded-lg border bg-code dark:bg-black/20"
        >
            <CodeEditor
                bind:value={sql}
                language="text"
                label="SQL query"
            />
        </div>
        <div class="flex items-center gap-3">
            <Button loading={run.isPending} onclick={execute}>
                <Play class="size-4" aria-hidden="true" />
                Run
            </Button>
            {#if run.data}
                <p
                    class="text-sm text-muted-foreground"
                    role="status"
                >
                    {run.data.command}
                </p>
            {/if}
        </div>

        {#if run.error}
            <Alert variant="error">
                <!-- PostgreSQL's caret lines up only in monospace with line breaks kept. -->
                <AlertDescription
                    class="font-mono text-xs whitespace-pre-wrap"
                >
                    {run.error.message}
                </AlertDescription>
            </Alert>
        {:else if run.data && run.data.columns.length > 0}
            <div class="overflow-auto rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            {#each run.data.columns as column, index (index)}
                                <TableHead>{column}</TableHead>
                            {/each}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {#each run.data.rows as row, index (index)}
                            <TableRow>
                                {#each row as value, column (column)}
                                    <TableCell
                                        class="max-w-80 truncate font-mono text-xs"
                                    >
                                        {#if value === null}
                                            <span
                                                class="text-muted-foreground"
                                            >
                                                NULL
                                            </span>
                                        {:else}
                                            {value}
                                        {/if}
                                    </TableCell>
                                {/each}
                            </TableRow>
                        {/each}
                    </TableBody>
                </Table>
            </div>
        {/if}
    </div>
</div>
