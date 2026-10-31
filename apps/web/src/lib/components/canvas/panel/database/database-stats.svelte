<script lang="ts">
    import { orpc, queryClient } from "$lib/api/orpc";
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
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { sqlQuery, type DatabaseInput } from "./query";

    let { input }: { input: DatabaseInput } = $props();

    const stats = createQuery(() => ({
        ...sqlQuery(
            input,
            `SELECT count(*),
                current_setting('max_connections'),
                count(*) FILTER (WHERE state = 'active'),
                count(*) FILTER (WHERE state = 'idle'),
                count(*) FILTER (WHERE state = 'idle in transaction'),
                (SELECT round(100 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 2) FROM pg_stat_database),
                EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')
             FROM pg_stat_activity WHERE backend_type = 'client backend'`,
        ),
        refetchInterval: 10_000,
    }));

    const values = $derived(stats.data?.rows[0] ?? []);

    const [
        connections,
        maxConnections,
        active,
        idle,
        idleInTransaction,
        cacheHit,
        statementsEnabled,
    ] = $derived(values);

    const enabled = $derived(statementsEnabled === "t");

    const statements = createQuery(() => ({
        ...sqlQuery(
            input,
            `SELECT query, calls, round(total_exec_time::numeric, 2), round(mean_exec_time::numeric, 2), rows
             FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20`,
        ),
        enabled,
    }));

    const enable = createMutation(() =>
        orpc.resources.enableQueryStatistics.mutationOptions({
            onSuccess: async () => {
                await stats.refetch();
                // A staged preload shows in the canvas as a pending change.
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                });
            },
        }),
    );

    const usage = $derived(
        connections && maxConnections
            ? Math.round(
                  (100 * Number(connections)) /
                      Number(maxConnections),
              )
            : 0,
    );

    const tiles = $derived([
        {
            label: "Connections",
            value: `${usage}%`,
            detail: `${connections} / ${maxConnections}`,
        },
        { label: "Active", value: active },
        { label: "Idle", value: idle },
        { label: "Idle in Txn", value: idleInTransaction },
        {
            label: "Cache Hit",
            value: cacheHit ? `${cacheHit}%` : "–",
        },
    ]);
</script>

{#if stats.isPending}
    <Skeleton loading label="Loading stats">
        <div class="grid grid-cols-5 gap-3">
            {#each tiles as tile (tile.label)}
                <div class="h-18 rounded-md border p-3 text-xs">
                    {tile.label}
                </div>
            {/each}
        </div>
    </Skeleton>
{:else if stats.isError}
    <Alert variant="error">
        <AlertDescription>{stats.error.message}</AlertDescription>
    </Alert>
{:else}
    <div class="grid grid-cols-2 gap-3 @lg:grid-cols-5">
        {#each tiles as tile (tile.label)}
            <div class="rounded-md border bg-background p-3">
                <p class="text-xs text-muted-foreground">
                    {tile.label}
                </p>
                <p class="mt-1 text-base tabular-nums">
                    {tile.value}
                </p>
                {#if tile.detail}
                    <p
                        class="text-xs text-muted-foreground tabular-nums"
                    >
                        {tile.detail}
                    </p>
                {/if}
            </div>
        {/each}
    </div>

    <section class="mt-10" aria-labelledby="query-statistics">
        <div class="flex items-center justify-between gap-4">
            <div>
                <h3
                    id="query-statistics"
                    class="text-base font-semibold"
                >
                    Query Statistics
                </h3>
                {#if !enabled}
                    <p class="mt-1 text-sm text-muted-foreground">
                        Enable pg_stat_statements to track query
                        performance.
                    </p>
                {/if}
            </div>
            {#if !enabled}
                <Button
                    loading={enable.isPending}
                    onclick={() => enable.mutate(input)}
                >
                    Enable
                </Button>
            {/if}
        </div>

        {#if enable.error}
            <Alert variant="error" class="mt-4">
                <AlertDescription>
                    {enable.error.message}
                </AlertDescription>
            </Alert>
        {:else if enable.data?.pendingDeployment}
            <p
                class="mt-4 text-sm text-warning-foreground"
                role="status"
            >
                PostgreSQL has to load pg_stat_statements at startup.
                Deploy the database, then enable it again.
            </p>
        {/if}

        {#if enabled && statements.isPending}
            <Skeleton
                loading
                label="Loading query statistics"
                class="mt-4"
            >
                <div class="h-40 rounded-md border"></div>
            </Skeleton>
        {:else if enabled && statements.isError}
            <Alert variant="error" class="mt-4">
                <AlertDescription>
                    {statements.error.message}
                </AlertDescription>
            </Alert>
        {:else if enabled && statements.data}
            <div class="mt-4 overflow-auto rounded-lg border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Query</TableHead>
                            <TableHead class="text-right">
                                Calls
                            </TableHead>
                            <TableHead class="text-right">
                                Total ms
                            </TableHead>
                            <TableHead class="text-right">
                                Mean ms
                            </TableHead>
                            <TableHead class="text-right">
                                Rows
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {#each statements.data.rows as [query, ...numbers], index (index)}
                            <TableRow>
                                <TableCell
                                    class="max-w-96 truncate font-mono text-xs"
                                    title={query ?? ""}
                                >
                                    {query}
                                </TableCell>
                                {#each numbers as value, column (column)}
                                    <TableCell
                                        class="text-right tabular-nums"
                                    >
                                        {value}
                                    </TableCell>
                                {/each}
                            </TableRow>
                        {:else}
                            <TableRow>
                                <TableCell
                                    colspan={5}
                                    class="text-muted-foreground"
                                >
                                    No queries recorded yet.
                                </TableCell>
                            </TableRow>
                        {/each}
                    </TableBody>
                </Table>
            </div>
        {/if}
    </section>
{/if}
