<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import {
        Menu,
        MenuCheckboxItem,
        MenuGroup,
        MenuGroupLabel,
        MenuItem,
        MenuPopup,
        MenuRadioGroup,
        MenuRadioItem,
        MenuSeparator,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        Popover,
        PopoverPopup,
        PopoverTitle,
        PopoverTrigger,
    } from "$lib/components/ui/popover";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        ToggleGroup,
        ToggleGroupItem,
    } from "$lib/components/ui/toggle-group";
    import { buttonVariants } from "$lib/components/ui/button";
    import ArrowUpDown from "@lucide/svelte/icons/arrow-up-down";
    import ChevronLeft from "@lucide/svelte/icons/chevron-left";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Columns3 from "@lucide/svelte/icons/columns-3";
    import Database from "@lucide/svelte/icons/database";
    import FileCode from "@lucide/svelte/icons/file-code";
    import ListFilter from "@lucide/svelte/icons/list-filter";
    import Network from "@lucide/svelte/icons/network";
    import Plus from "@lucide/svelte/icons/plus";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import Search from "@lucide/svelte/icons/search";
    import Sheet from "@lucide/svelte/icons/sheet";
    import TableIcon from "@lucide/svelte/icons/table";
    import X from "@lucide/svelte/icons/x";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsInteger,
        parseAsJson,
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";
    import * as v from "valibot";
    import DatabaseGrid from "./database-grid.svelte";
    import DatabaseSql from "./database-sql.svelte";
    import {
        compactCount,
        PAGE_SIZE,
        pageSql,
        parsePage,
        tableListSql,
        filterOperatorLabels,
        filterOperators,
        filterSchema,
        quoteIdent,
        quoteLiteral,
        sqlQuery,
        whereClause,
        type DatabaseInput,
        type Filter,
    } from "./query";

    let { input }: { input: DatabaseInput } = $props();

    const views = ["data", "structure", "sql"] as const;

    const urlOptions = {
        history: "replace",
        shallow: true,
        scroll: false,
    } as const;

    // `schema.table`, matched against the list rather than split, since names may hold dots.
    const tableParam = useQueryState(
        "dbTable",
        parseAsString.withOptions(urlOptions),
    );

    const view = useQueryState(
        "dbView",
        parseAsStringLiteral(views)
            .withDefault("data")
            .withOptions(urlOptions),
    );

    const page = useQueryState(
        "dbPage",
        parseAsInteger.withDefault(1).withOptions(urlOptions),
    );

    const sortColumn = useQueryState(
        "dbSort",
        parseAsString.withOptions(urlOptions),
    );

    const sortDesc = useQueryState(
        "dbDesc",
        parseAsBoolean.withDefault(false).withOptions(urlOptions),
    );

    const filtersParam = useQueryState(
        "dbFilters",
        parseAsJson((value) => v.parse(v.array(filterSchema), value))
            .withDefault([])
            .withOptions(urlOptions),
    );

    const tables = createQuery(() => sqlQuery(input, tableListSql));

    const databaseName = $derived(tables.data?.rows[0]?.[0]);

    let search = $state("");

    const tableList = $derived(
        (tables.data?.rows ?? []).map(([, schema, name, count]) => ({
            key: `${schema}.${name}`,
            schema: schema ?? "",
            name: name ?? "",
            label:
                schema === "public"
                    ? (name ?? "")
                    : `${schema}.${name}`,
            estimate: Number(count ?? 0),
        })),
    );

    const visibleTables = $derived(
        tableList.filter((table) =>
            table.label
                .toLowerCase()
                .includes(search.trim().toLowerCase()),
        ),
    );

    const table = $derived(
        tableList.find((table) => table.key === tableParam.current) ??
            tableList[0],
    );

    const ident = $derived(
        table
            ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
            : "",
    );

    const filters = $derived(filtersParam.current);

    const where = $derived(whereClause(filters));

    const order = $derived(
        sortColumn.current
            ? `ORDER BY ${quoteIdent(sortColumn.current)} ${sortDesc.current ? "DESC" : "ASC"} NULLS LAST`
            : "",
    );

    const offset = $derived(
        (Math.max(page.current, 1) - 1) * PAGE_SIZE,
    );

    // Columns and one page of rows, cut short per cell, in a single round trip.
    const pageQuery = createQuery(() => ({
        ...sqlQuery(input, pageSql(ident, where, order, offset)),
        enabled: !!table,
        // Paging, sorting or filtering keeps the rows on screen; another table starts from a skeleton.
        placeholderData: (previous, previousQuery) =>
            (JSON.stringify(previousQuery?.queryKey) ?? "").includes(
                JSON.stringify(`FROM ${ident} `).slice(1, -1),
            )
                ? previous
                : undefined,
    }));

    const tablePage = $derived(
        pageQuery.data?.rows[0]?.[0]
            ? parsePage(pageQuery.data.rows[0][0])
            : undefined,
    );

    const columnInfo = $derived(tablePage?.columns ?? []);

    // An exact count scans the table, so a big one without filters shows its estimate instead.
    const estimated = $derived(
        !!table && filters.length === 0 && table.estimate > 100_000,
    );

    const count = createQuery(() => ({
        ...sqlQuery(input, `SELECT count(*) FROM ${ident} ${where}`),
        enabled: !!table && view.current === "data" && !estimated,
        placeholderData: (previous, previousQuery) =>
            (JSON.stringify(previousQuery?.queryKey) ?? "").includes(
                JSON.stringify(`FROM ${ident} `).slice(1, -1),
            )
                ? previous
                : undefined,
    }));

    const total = $derived(
        estimated
            ? (table?.estimate ?? 0)
            : count.data
              ? Number(count.data.rows[0]?.[0] ?? 0)
              : undefined,
    );

    const indexes = createQuery(() => ({
        ...sqlQuery(
            input,
            `SELECT indexname, indexdef FROM pg_indexes
             WHERE schemaname = ${quoteLiteral(table?.schema ?? "")} AND tablename = ${quoteLiteral(table?.name ?? "")}
             ORDER BY indexname`,
        ),
        enabled: !!table && view.current === "structure",
    }));

    // Hidden columns per table, for this visit only.
    let hiddenByTable = $state<Record<string, string[]>>({});

    const hidden = $derived(
        table ? (hiddenByTable[table.key] ?? []) : [],
    );

    const gridColumns = $derived(
        columnInfo.flatMap((column, index) =>
            hidden.includes(column.name)
                ? []
                : [
                      {
                          index,
                          name: column.name,
                          type: column.type,
                          primary: column.primary,
                      },
                  ],
        ),
    );

    let sql = $state("SELECT now();");

    function selectTable(key: string) {
        void tableParam.set(key);
        void page.set(null);
        void sortColumn.set(null);
        void sortDesc.set(null);
        void filtersParam.set(null);
    }

    // Railway-style header sort: ascending, then descending, then off.
    function toggleSort(column: string) {
        if (sortColumn.current !== column) {
            void sortColumn.set(column);
            void sortDesc.set(null);
        } else if (!sortDesc.current) void sortDesc.set(true);
        else {
            void sortColumn.set(null);
            void sortDesc.set(null);
        }

        void page.set(null);
    }

    function toggleColumn(name: string, visible: boolean) {
        if (!table) return;

        hiddenByTable[table.key] = visible
            ? hidden.filter((column) => column !== name)
            : [...hidden, name];
    }

    let filtersOpen = $state(false);

    let draft = $state<Filter[]>([]);

    function applyFilters() {
        void filtersParam.set(
            draft.length
                ? draft.filter((filter) => filter.column)
                : null,
        );
        void page.set(null);
        filtersOpen = false;
    }

    function refresh() {
        void tables.refetch();
        void pageQuery.refetch();

        if (view.current === "data" && !estimated)
            void count.refetch();

        if (view.current === "structure") void indexes.refetch();
    }

    const refreshing = $derived(
        tables.isRefetching ||
            pageQuery.isRefetching ||
            count.isRefetching ||
            indexes.isRefetching,
    );

    const operatorItems = filterOperators.map((operator) => ({
        value: operator,
        label: filterOperatorLabels[operator],
    }));

    const columnItems = $derived(
        columnInfo.map((column) => ({
            value: column.name,
            label: column.name,
        })),
    );
</script>

<div class="flex h-full min-h-0">
    <nav
        class="flex w-60 shrink-0 flex-col border-r"
        aria-label="Tables"
    >
        <div class="flex items-center gap-2 px-4 py-3 text-sm">
            <Database
                class="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
            <!-- Inline text keeps no width inside skullet's reveal, so only the placeholder is wrapped. -->
            {#if tables.isPending}
                <Skeleton loading label="Loading database">
                    <span class="block font-medium">database</span>
                </Skeleton>
            {:else}
                <span class="truncate font-medium">
                    {databaseName ?? "Database"}
                </span>
            {/if}
            <span class="ml-auto text-xs text-muted-foreground">
                Postgres
            </span>
        </div>
        <div class="relative px-3 pb-2">
            <Search
                class="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-[calc(50%+4px)] text-muted-foreground"
                aria-hidden="true"
            />
            <Input
                size="sm"
                type="search"
                class="[&_input]:ps-7"
                bind:value={search}
                placeholder="Filter tables"
                aria-label="Filter tables"
            />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {#if tables.isPending}
                <Skeleton loading label="Loading tables">
                    <div class="space-y-1 px-2">
                        {#each ["users", "sessions", "accounts", "organizations", "api_keys", "audit_events"] as name (name)}
                            <p
                                class="flex justify-between py-1.5 text-sm"
                            >
                                {name}
                                <span>100</span>
                            </p>
                        {/each}
                    </div>
                </Skeleton>
            {:else if tables.isError}
                <p class="px-2 text-sm text-destructive-foreground">
                    {tables.error.message}
                </p>
            {:else}
                <ul>
                    {#each visibleTables as item (item.key)}
                        <li>
                            <button
                                type="button"
                                class={[
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                                    item.key === table?.key &&
                                        "bg-accent text-foreground",
                                ]}
                                aria-current={item.key === table?.key
                                    ? "true"
                                    : undefined}
                                onclick={() => selectTable(item.key)}
                            >
                                <TableIcon
                                    class="size-3.5 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                />
                                <span class="min-w-0 flex-1 truncate">
                                    {item.label}
                                </span>
                                <span
                                    class="text-xs text-muted-foreground tabular-nums"
                                >
                                    {compactCount(item.estimate)}
                                </span>
                            </button>
                        </li>
                    {:else}
                        <li
                            class="px-2 text-sm text-muted-foreground"
                        >
                            {search.trim()
                                ? "No matching tables."
                                : "No tables yet."}
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    </nav>

    <div class="flex min-w-0 flex-1 flex-col">
        <div
            class="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        >
            <ToggleGroup
                variant="outline"
                size="sm"
                aria-label="View"
                value={[view.current]}
                onValueChange={(next) => {
                    const value = views.find(
                        (item) => item === next[0],
                    );

                    if (value) void view.set(value);
                }}
            >
                <ToggleGroupItem value="data">
                    <Sheet aria-hidden="true" />
                    Data
                </ToggleGroupItem>
                <ToggleGroupItem value="structure">
                    <Network aria-hidden="true" />
                    Structure
                </ToggleGroupItem>
                <ToggleGroupItem value="sql">
                    <FileCode aria-hidden="true" />
                    SQL
                </ToggleGroupItem>
            </ToggleGroup>

            {#if view.current === "data" && table}
                <Popover
                    bind:open={
                        () => filtersOpen,
                        (open) => {
                            if (open)
                                draft = filters.map((filter) => ({
                                    ...filter,
                                }));
                            filtersOpen = open;
                        }
                    }
                >
                    <PopoverTrigger
                        class={buttonVariants({
                            variant: "outline",
                            size: "sm",
                        })}
                    >
                        <ListFilter aria-hidden="true" />
                        Filters
                        {#if filters.length}
                            <span class="text-muted-foreground">
                                {filters.length}
                            </span>
                        {/if}
                    </PopoverTrigger>
                    <PopoverPopup
                        align="start"
                        class="w-[32rem] max-w-[calc(100vw-2rem)]"
                    >
                        <PopoverTitle
                            class="mb-3 text-sm font-medium"
                        >
                            Filters
                        </PopoverTitle>
                        <div class="space-y-2">
                            {#each draft as filter, index (index)}
                                <div class="flex items-center gap-2">
                                    <Select
                                        bind:value={filter.column}
                                        items={columnItems}
                                    >
                                        <SelectTrigger
                                            size="sm"
                                            class="w-36"
                                            aria-label="Column"
                                        >
                                            <SelectValue
                                                placeholder="Column"
                                            />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {#each columnItems as item (item.value)}
                                                <SelectItem
                                                    value={item.value}
                                                    label={item.label}
                                                >
                                                    {item.label}
                                                </SelectItem>
                                            {/each}
                                        </SelectContent>
                                    </Select>
                                    <Select
                                        bind:value={filter.operator}
                                        items={operatorItems}
                                    >
                                        <SelectTrigger
                                            size="sm"
                                            class="w-32"
                                            aria-label="Operator"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {#each operatorItems as item (item.value)}
                                                <SelectItem
                                                    value={item.value}
                                                    label={item.label}
                                                >
                                                    {item.label}
                                                </SelectItem>
                                            {/each}
                                        </SelectContent>
                                    </Select>
                                    {#if filter.operator !== "null" && filter.operator !== "notNull"}
                                        <Input
                                            size="sm"
                                            class="min-w-0 flex-1"
                                            bind:value={filter.value}
                                            placeholder="Value"
                                            aria-label="Value"
                                            onkeydown={(event) => {
                                                if (
                                                    event.key ===
                                                    "Enter"
                                                )
                                                    applyFilters();
                                            }}
                                        />
                                    {:else}
                                        <span class="flex-1"></span>
                                    {/if}
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label="Remove filter"
                                        onclick={() =>
                                            draft.splice(index, 1)}
                                    >
                                        <X aria-hidden="true" />
                                    </Button>
                                </div>
                            {:else}
                                <p
                                    class="text-sm text-muted-foreground"
                                >
                                    No filters. Rows match every
                                    filter you add.
                                </p>
                            {/each}
                        </div>
                        <div class="mt-3 flex justify-between gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onclick={() =>
                                    draft.push({
                                        column:
                                            columnInfo[0]?.name ?? "",
                                        operator: "equals",
                                        value: "",
                                    })}
                            >
                                <Plus aria-hidden="true" />
                                Add filter
                            </Button>
                            <Button size="sm" onclick={applyFilters}>
                                Apply
                            </Button>
                        </div>
                    </PopoverPopup>
                </Popover>

                <Menu>
                    <MenuTrigger
                        class={buttonVariants({
                            variant: "outline",
                            size: "sm",
                        })}
                    >
                        <ArrowUpDown aria-hidden="true" />
                        Sort
                    </MenuTrigger>
                    <MenuPopup
                        align="start"
                        class="max-h-80 min-w-48"
                    >
                        <MenuGroup>
                            <MenuGroupLabel>Column</MenuGroupLabel>
                            <MenuRadioGroup
                                bind:value={
                                    () => sortColumn.current ?? "",
                                    (column) => {
                                        void sortColumn.set(
                                            column || null,
                                        );
                                        void page.set(null);
                                    }
                                }
                            >
                                {#each columnInfo as column (column.name)}
                                    <MenuRadioItem
                                        value={column.name}
                                    >
                                        {column.name}
                                    </MenuRadioItem>
                                {/each}
                            </MenuRadioGroup>
                        </MenuGroup>
                        <MenuSeparator />
                        <MenuRadioGroup
                            bind:value={
                                () =>
                                    sortDesc.current ? "desc" : "asc",
                                (direction) =>
                                    void sortDesc.set(
                                        direction === "desc" || null,
                                    )
                            }
                        >
                            <MenuRadioItem value="asc">
                                Ascending
                            </MenuRadioItem>
                            <MenuRadioItem value="desc">
                                Descending
                            </MenuRadioItem>
                        </MenuRadioGroup>
                        {#if sortColumn.current}
                            <MenuSeparator />
                            <MenuItem
                                onclick={() =>
                                    toggleSort(
                                        sortColumn.current ?? "",
                                    )}
                            >
                                Clear sort
                            </MenuItem>
                        {/if}
                    </MenuPopup>
                </Menu>

                <Menu>
                    <MenuTrigger
                        class={buttonVariants({
                            variant: "outline",
                            size: "sm",
                        })}
                    >
                        <Columns3 aria-hidden="true" />
                        Columns
                    </MenuTrigger>
                    <MenuPopup
                        align="start"
                        class="max-h-80 min-w-48"
                    >
                        {#each columnInfo as column (column.name)}
                            <MenuCheckboxItem
                                checked={!hidden.includes(
                                    column.name,
                                )}
                                onCheckedChange={(checked) =>
                                    toggleColumn(
                                        column.name,
                                        checked,
                                    )}
                            >
                                {column.name}
                            </MenuCheckboxItem>
                        {/each}
                    </MenuPopup>
                </Menu>

                <div class="ml-auto flex shrink-0 items-center gap-1">
                    {#if total === undefined}
                        <Skeleton loading label="Counting rows">
                            <span
                                class="block px-2 font-mono text-xs"
                            >
                                1 – 50 of 1,000
                            </span>
                        </Skeleton>
                    {:else}
                        <span
                            class="px-2 font-mono text-xs text-muted-foreground tabular-nums"
                            role="status"
                        >
                            {#if total === 0}
                                0 rows
                            {:else}
                                {offset + 1} – {Math.min(
                                    offset + PAGE_SIZE,
                                    total,
                                )} of {estimated
                                    ? "~"
                                    : ""}{total.toLocaleString()}
                            {/if}
                        </span>
                    {/if}
                    <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Previous page"
                        disabled={offset === 0}
                        onclick={() =>
                            void page.set(
                                page.current - 1 > 1
                                    ? page.current - 1
                                    : null,
                            )}
                    >
                        <ChevronLeft aria-hidden="true" />
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="outline"
                        aria-label="Next page"
                        disabled={(tablePage?.rows.length ?? 0) <
                            PAGE_SIZE}
                        onclick={() =>
                            void page.set(page.current + 1)}
                    >
                        <ChevronRight aria-hidden="true" />
                    </Button>
                </div>
            {/if}

            <Button
                size="icon-sm"
                variant="outline"
                class={view.current === "data" && table
                    ? ""
                    : "ml-auto"}
                aria-label="Refresh"
                disabled={refreshing}
                onclick={refresh}
            >
                <RefreshCw
                    class={refreshing ? "animate-spin" : ""}
                    aria-hidden="true"
                />
            </Button>
        </div>

        <div class="relative min-h-0 flex-1 overflow-auto">
            {#if pageQuery.isPlaceholderData || refreshing}
                <!-- Rows stay on screen while the next page, sort or filter loads. -->
                <div
                    class="sticky top-0 z-20 -mb-0.5 h-0.5 overflow-hidden bg-primary/20"
                    role="progressbar"
                    aria-label="Loading"
                >
                    <div
                        class="h-full w-1/3 animate-progress bg-primary"
                    ></div>
                </div>
            {/if}
            {#if view.current === "sql"}
                <DatabaseSql
                    {input}
                    bind:sql
                    onrun={() => void tables.refetch()}
                />
            {:else if tables.isError}
                <p
                    class="p-6 font-mono text-xs whitespace-pre-wrap text-destructive-foreground"
                >
                    {tables.error.message}
                </p>
            {:else if !tables.isPending && !table}
                <p class="p-6 text-sm text-muted-foreground">
                    This database has no tables yet. Create one from
                    SQL.
                </p>
            {:else if pageQuery.isError}
                <p
                    class="p-6 font-mono text-xs whitespace-pre-wrap text-destructive-foreground"
                >
                    {pageQuery.error.message}
                </p>
            {:else if !tablePage}
                {@render gridSkeleton()}
            {:else if view.current === "data"}
                <div
                    class={[
                        "transition-opacity",
                        pageQuery.isPlaceholderData && "opacity-60",
                    ]}
                >
                    <DatabaseGrid
                        columns={gridColumns}
                        rows={tablePage.rows}
                        sort={sortColumn.current
                            ? {
                                  column: sortColumn.current,
                                  desc: sortDesc.current,
                              }
                            : null}
                        onsort={toggleSort}
                    />
                    {#if tablePage.rows.length === 0}
                        <p class="p-6 text-sm text-muted-foreground">
                            {filters.length
                                ? "No rows match these filters."
                                : "This table has no rows yet."}
                        </p>
                    {/if}
                </div>
            {:else}
                <div class="space-y-8 p-6">
                    <section aria-label="Columns">
                        <h3 class="mb-3 text-sm font-semibold">
                            Columns
                        </h3>
                        <div
                            class="overflow-x-auto rounded-lg border"
                        >
                            <DatabaseGrid
                                columns={[
                                    { index: 0, name: "name" },
                                    { index: 1, name: "type" },
                                    { index: 2, name: "nullable" },
                                    { index: 3, name: "default" },
                                    { index: 4, name: "primary key" },
                                ]}
                                rows={columnInfo.map((column) => [
                                    column.name,
                                    column.type,
                                    column.nullable ? "yes" : "no",
                                    column.defaultValue,
                                    column.primary ? "yes" : "",
                                ])}
                            />
                        </div>
                    </section>
                    <section aria-label="Indexes">
                        <h3 class="mb-3 text-sm font-semibold">
                            Indexes
                        </h3>
                        {#if indexes.isPending}
                            <Skeleton loading label="Loading indexes">
                                <div
                                    class="h-20 rounded-lg border"
                                ></div>
                            </Skeleton>
                        {:else if indexes.isError}
                            <p
                                class="font-mono text-xs whitespace-pre-wrap text-destructive-foreground"
                            >
                                {indexes.error.message}
                            </p>
                        {:else if indexes.data.rows.length}
                            <div
                                class="overflow-x-auto rounded-lg border"
                            >
                                <DatabaseGrid
                                    columns={[
                                        { index: 0, name: "name" },
                                        {
                                            index: 1,
                                            name: "definition",
                                        },
                                    ]}
                                    rows={indexes.data.rows}
                                />
                            </div>
                        {:else}
                            <p class="text-sm text-muted-foreground">
                                No indexes.
                            </p>
                        {/if}
                    </section>
                </div>
            {/if}
        </div>
    </div>
</div>

{#snippet gridSkeleton()}
    <Skeleton loading label="Loading rows">
        <table class="w-full border-collapse text-xs">
            <thead>
                <tr>
                    {#each ["id", "name", "created_at", "updated_at"] as name (name)}
                        <th
                            class="border-r border-b px-3 py-2 text-left last:border-r-0"
                        >
                            {name} text
                        </th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#each { length: 12 }, row (row)}
                    <tr>
                        {#each { length: 4 }, cell (cell)}
                            <td
                                class="border-r border-b px-3 py-2 last:border-r-0"
                            >
                                {cell === 0
                                    ? row + 1
                                    : "placeholder value"}
                            </td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </Skeleton>
{/snippet}
