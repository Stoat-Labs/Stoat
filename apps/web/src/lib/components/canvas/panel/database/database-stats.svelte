<script lang="ts">
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import ArrowDown from "@lucide/svelte/icons/arrow-down";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";
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

    const sortKeys = [
        "calls",
        "rows",
        "total",
        "mean",
        "max",
    ] as const;

    const statementsSort = useQueryState(
        "statementsSort",
        parseAsStringLiteral(sortKeys)
            .withDefault("total")
            .withOptions({
                history: "replace",
                shallow: true,
                scroll: false,
            }),
    );

    const sortColumns = {
        calls: "calls",
        rows: "rows",
        total: "total_exec_time",
        mean: "mean_exec_time",
        max: "max_exec_time",
    } satisfies Record<(typeof sortKeys)[number], string>;

    // This database's top 100 statements by the chosen column, whitespace collapsed and cut short to keep it light.
    const statements = createQuery(() => ({
        ...sqlQuery(
            input,
            `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 500), calls, rows,
                total_exec_time, mean_exec_time, max_exec_time,
                (SELECT stats_reset FROM pg_stat_statements_info), count(*) OVER ()
             FROM pg_stat_statements
             WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
             ORDER BY ${sortColumns[statementsSort.current]} DESC LIMIT 100`,
        ),
        enabled,
        placeholderData: (previous) => previous,
    }));

    const columns = [
        { key: "calls", label: "Calls" },
        { key: "rows", label: "Rows Returned" },
        { key: "total", label: "Total" },
        { key: "mean", label: "Mean" },
        { key: "max", label: "Max" },
    ] as const;

    const statementRows = $derived(
        (statements.data?.rows ?? [])
            .map(([query, calls, rows, total, mean, max]) => ({
                query: query ?? "",
                calls: Number(calls),
                rows: Number(rows),
                total: Number(total),
                mean: Number(mean),
                max: Number(max),
            }))
            .toSorted(
                (left, right) =>
                    right[statementsSort.current] -
                    left[statementsSort.current],
            ),
    );

    const since = $derived(statements.data?.rows[0]?.[6]);

    const statementCount = $derived(
        Number(statements.data?.rows[0]?.[7] ?? 0),
    );

    let showAll = $state(false);

    const shownStatements = $derived(
        showAll ? statementRows : statementRows.slice(0, 3),
    );

    const duration = (ms: number) =>
        ms >= 1000
            ? `${(ms / 1000).toFixed(2)}s`
            : `${ms.toFixed(1)}ms`;

    let resetting = $state(false);

    const reset = createMutation(() =>
        orpc.resources.queryPostgres.mutationOptions({
            onSuccess: async () => {
                resetting = false;
                await statements.refetch();
            },
        }),
    );

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
            {:else}
                <div class="flex items-center gap-2">
                    {#if since}
                        <span class="text-sm text-muted-foreground">
                            Since {new Date(
                                since,
                            ).toLocaleDateString()}
                        </span>
                    {/if}
                    <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Refresh query statistics"
                        disabled={statements.isFetching}
                        onclick={() => void statements.refetch()}
                    >
                        <RefreshCw
                            class={statements.isFetching
                                ? "animate-spin"
                                : ""}
                            aria-hidden="true"
                        />
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onclick={() => {
                            reset.reset();
                            resetting = true;
                        }}
                    >
                        Reset
                    </Button>
                </div>
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
                <div class="space-y-3">
                    {#each { length: 4 }, index (index)}
                        <p class="font-mono text-xs">
                            SELECT id, name FROM users WHERE id = $1
                        </p>
                    {/each}
                </div>
            </Skeleton>
        {:else if enabled && statements.isError}
            <Alert variant="error" class="mt-4">
                <AlertDescription>
                    {statements.error.message}
                </AlertDescription>
            </Alert>
        {:else if enabled && statements.data}
            <div class="mt-4 overflow-x-auto">
                <table
                    class="w-full min-w-[40rem] table-fixed text-sm"
                >
                    <thead>
                        <tr class="border-b">
                            <th
                                class="py-2 pr-4 text-left font-medium"
                            >
                                Query
                            </th>
                            {#each columns as column (column.key)}
                                <th
                                    class={[
                                        "py-2 pl-4 text-right font-medium whitespace-nowrap",
                                        column.key === "rows"
                                            ? "w-36"
                                            : "w-24",
                                    ]}
                                    aria-sort={statementsSort.current ===
                                    column.key
                                        ? "descending"
                                        : undefined}
                                >
                                    <button
                                        type="button"
                                        class="inline-flex items-center gap-1 hover:text-foreground"
                                        onclick={() =>
                                            void statementsSort.set(
                                                column.key,
                                            )}
                                    >
                                        {#if statementsSort.current === column.key}
                                            <ArrowDown
                                                class="size-3.5"
                                                aria-hidden="true"
                                            />
                                        {/if}
                                        {column.label}
                                    </button>
                                </th>
                            {/each}
                        </tr>
                    </thead>
                    <tbody>
                        {#each shownStatements as statement, index (index)}
                            <tr class="border-b">
                                <td
                                    class="truncate py-3 pr-4 font-mono text-xs"
                                    title={statement.query}
                                >
                                    {statement.query}
                                </td>
                                <td
                                    class="py-3 pl-4 text-right tabular-nums"
                                >
                                    {statement.calls.toLocaleString()}
                                </td>
                                <td
                                    class="py-3 pl-4 text-right tabular-nums"
                                >
                                    {statement.rows.toLocaleString()}
                                </td>
                                <td
                                    class="py-3 pl-4 text-right tabular-nums"
                                >
                                    {duration(statement.total)}
                                </td>
                                <td
                                    class="py-3 pl-4 text-right tabular-nums"
                                >
                                    {duration(statement.mean)}
                                </td>
                                <td
                                    class="py-3 pl-4 text-right tabular-nums"
                                >
                                    {duration(statement.max)}
                                </td>
                            </tr>
                        {:else}
                            <tr>
                                <td
                                    colspan={6}
                                    class="py-3 text-muted-foreground"
                                >
                                    No queries recorded yet.
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
            {#if statementRows.length > 3}
                <Button
                    variant="link"
                    size="sm"
                    class="mt-2 px-0"
                    onclick={() => (showAll = !showAll)}
                >
                    {showAll
                        ? "Show fewer"
                        : statementCount > statementRows.length
                          ? `Show top ${statementRows.length} of ${statementCount.toLocaleString()} queries`
                          : `Show all ${statementCount.toLocaleString()} queries`}
                </Button>
            {/if}
        {/if}
    </section>
{/if}

<ConfirmDialog
    bind:open={resetting}
    title="Reset query statistics?"
    description="Clears every recorded query for this database. Statistics start collecting again from now."
    confirmLabel="Reset"
    pending={reset.isPending}
    error={reset.error?.message}
    onconfirm={() =>
        reset.mutate({
            ...input,
            // Only this database's statements; other databases on the server keep theirs.
            query: "SELECT pg_stat_statements_reset(dbid => oid) FROM pg_database WHERE datname = current_database()",
        })}
/>
