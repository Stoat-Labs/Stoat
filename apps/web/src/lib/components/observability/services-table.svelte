<script lang="ts">
    import { resourceHref } from "$lib/api/hrefs";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import {
        Meter,
        MeterIndicator,
        MeterTrack,
    } from "$lib/components/ui/meter";
    import {
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import {
        bandwidth,
        bytes,
        containerHealth,
        cores,
        percent,
        serviceHealth,
        usageLevel,
        type ContainerRow,
        type Health,
        type ServiceRow,
    } from "$lib/observability";
    import ArrowDown from "phosphor-svelte/lib/ArrowDownIcon";
    import ArrowUp from "phosphor-svelte/lib/ArrowUpIcon";
    import ChevronRight from "phosphor-svelte/lib/CaretRightIcon";
    import {
        createTable,
        functionalUpdate,
        getCoreRowModel,
        getFilteredRowModel,
        getSortedRowModel,
        type ColumnDef,
        type SortingState,
    } from "@tanstack/table-core";
    import { createVirtualizer } from "@tanstack/svelte-virtual";
    import { createParser, useQueryState } from "nuqs-svelte";
    import { untrack } from "svelte";
    import { SvelteSet } from "svelte/reactivity";

    let {
        data,
        search = $bindable(""),
        expandAll = false,
        hovered = $bindable(""),
    }: {
        data: ServiceRow[];
        search?: string;
        expandAll?: boolean;
        hovered?: string;
    } = $props();

    const sortColumns = [
        "name",
        "clusterName",
        "machines",
        "cpu",
        "memory",
        "networkIn",
        "networkOut",
    ] as const;

    const numericColumns = [
        "cpu",
        "memory",
        "networkIn",
        "networkOut",
    ];

    const columnHints = new Map([
        [
            "cpu",
            "100% is one core. The bar is the share of the limit, or of machine cores when unlimited.",
        ],
        [
            "memory",
            "The bar is the share of the limit, or of machine memory when unlimited.",
        ],
    ]);

    const serializeSort = (state: SortingState) =>
        state.length
            ? state
                  .map(
                      ({ id, desc }) =>
                          `${id}.${desc ? "desc" : "asc"}`,
                  )
                  .join(",")
            : "none";

    const defaultSort: SortingState = [{ id: "cpu", desc: true }];

    // "cpu.desc,memory.asc" in the URL, so a reload or shared link keeps every sorted column;
    // "none" keeps a cleared sort from snapping back to the default.
    const sortParam = useQueryState(
        "servicesSort",
        createParser<SortingState>({
            parse(value) {
                if (value === "none") return [];

                const state: SortingState = [];

                for (const part of value.split(",")) {
                    const [id, direction] = part.split(".");

                    if (
                        !sortColumns.some(
                            (column) => column === id,
                        ) ||
                        (direction !== "asc" && direction !== "desc")
                    )
                        return null;

                    state.push({
                        id: id!,
                        desc: direction === "desc",
                    });
                }

                return state;
            },
            serialize: serializeSort,
            eq: (a, b) => serializeSort(a) === serializeSort(b),
        }).withOptions({ shallow: true, scroll: false }),
    );

    // No param means the default, health-first order; an explicit "cpu.desc" sorts by CPU alone.
    const sorting = $derived(sortParam.current ?? defaultSort);

    let viewport = $state<HTMLDivElement>();

    // Keys whose expansion differs from the default, so `expandAll` needs no per-row setup.
    const toggled = new SvelteSet<string>();

    const columns: ColumnDef<ServiceRow>[] = [
        { id: "name", accessorKey: "name", header: "Service" },
        {
            id: "clusterName",
            accessorKey: "clusterName",
            header: "Cluster",
        },
        {
            id: "machines",
            accessorFn: (row) => row.machines.join(", "),
            header: "Machine",
        },
        {
            id: "cpu",
            accessorFn: (row) => row.cpu ?? undefined,
            header: "CPU",
            sortUndefined: "last",
        },
        {
            id: "memory",
            accessorFn: (row) => row.memory ?? undefined,
            header: "Memory",
            sortUndefined: "last",
        },
        {
            id: "networkIn",
            accessorFn: (row) => row.networkIn ?? undefined,
            header: "Net in",
            sortUndefined: "last",
        },
        {
            id: "networkOut",
            accessorFn: (row) => row.networkOut ?? undefined,
            header: "Net out",
            sortUndefined: "last",
        },
    ];

    const showCluster = $derived(
        new Set(data.map((row) => row.clusterId)).size > 1,
    );

    const table = $derived.by(() => {
        const instance = createTable<ServiceRow>({
            data,
            columns,
            state: {},
            onStateChange: () => {},
            renderFallbackValue: "—",
            onSortingChange: (update) => {
                void sortParam.set(functionalUpdate(update, sorting));
                viewport?.scrollTo({ top: 0 });
            },
            getCoreRowModel: getCoreRowModel(),
            getSortedRowModel: getSortedRowModel(),
            getFilteredRowModel: getFilteredRowModel(),
            getRowId: (row) => row.key,
            globalFilterFn: "includesString",
        });

        const state = {
            ...instance.initialState,
            sorting,
            globalFilter: search,
            columnVisibility: { clusterName: showCluster },
        };

        instance.setOptions((options) => ({ ...options, state }));

        return instance;
    });

    const healthOf = (row: ServiceRow) =>
        serviceHealth(row, Date.now());

    const levelRank = { error: 0, warning: 1, ok: 2 };

    // Problems come first until someone picks their own sort.
    const services = $derived.by(() => {
        const rows = table.getRowModel().rows;

        if (sortParam.current !== null) return rows;

        return rows.toSorted(
            (a, b) =>
                levelRank[healthOf(a.original).level] -
                levelRank[healthOf(b.original).level],
        );
    });

    const needAttention = $derived(
        services.filter(
            ({ original }) => healthOf(original).level !== "ok",
        ).length,
    );

    const expanded = (key: string) => expandAll !== toggled.has(key);

    type Line = {
        key: string;
        service: ServiceRow;
        container?: ContainerRow;
    };

    const lines = $derived(
        services.flatMap(({ original: service }): Line[] => [
            { key: service.key, service },
            ...(expanded(service.key)
                ? service.containers.map((container) => ({
                      key: container.key,
                      service,
                      container,
                  }))
                : []),
        ]),
    );

    const rowHeight = 40;

    // Share flexible tracks across the header and virtual rows, preserving readable minimums.
    const tableGrid = $derived(
        showCluster
            ? "grid-cols-[minmax(16rem,3fr)_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(10rem,1fr)_minmax(12rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)]"
            : "grid-cols-[minmax(16rem,3fr)_minmax(8rem,1fr)_minmax(10rem,1fr)_minmax(12rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)]",
    );

    const virtualizer = createVirtualizer<
        HTMLDivElement,
        HTMLTableRowElement
    >({
        count: 0,
        getScrollElement: () => viewport ?? null,
        estimateSize: () => rowHeight,
        overscan: 12,
    });

    $effect(() => {
        // Synchronize the external virtualizer with the derived row model and mounted viewport.
        const current = lines;
        void viewport;
        untrack(() =>
            $virtualizer.setOptions({
                count: current.length,
                getItemKey: (index) => current[index]!.key,
            }),
        );
    });

    const items = $derived($virtualizer.getVirtualItems());

    const missingMetrics = $derived(
        data.length > 0 &&
            data.every(
                (row) => row.cpu === null && row.memory === null,
            ),
    );

    function toggle(key: string) {
        if (toggled.has(key)) toggled.delete(key);
        else toggled.add(key);
    }

    const dotColors = {
        ok: "bg-success",
        warning: "bg-warning",
        error: "bg-destructive",
    };

    const reasonColors = {
        ok: "text-muted-foreground",
        warning: "text-warning-foreground",
        error: "text-destructive-foreground",
    };

    const meterColors = {
        normal: "bg-primary",
        warning: "bg-warning",
        critical: "bg-destructive",
    };

    function cpuTitle(row: ServiceRow | ContainerRow) {
        if (row.cpu === null) return undefined;

        const limit = row.cpuLimit
            ? ` of ${cores(row.cpuLimit)} limit`
            : "";

        return `${cores(row.cpu / 100)}${limit} · ${percent(row.cpuPercent)}`;
    }

    function memoryTitle(row: ServiceRow | ContainerRow) {
        if (row.memory === null) return undefined;

        const limit = row.memoryLimit
            ? `of ${bytes(row.memoryLimit)} limit`
            : "of machine memory";

        return `${percent(row.memoryPercent)} ${limit}`;
    }
</script>

{#snippet dot(health: Health)}
    <span
        class="size-2 shrink-0 rounded-full {dotColors[health.level]}"
        role="img"
        aria-label={health.reason}
        title={health.reason}
    ></span>
{/snippet}

{#snippet meter(
    label: string,
    kind: "cpu" | "memory",
    value: number | null,
)}
    <!-- Keeps its width without a value, so the numbers stay aligned. -->
    <div class="w-12 shrink-0">
        {#if value !== null}
            <Meter value={Math.min(value, 100)} aria-label={label}>
                <MeterTrack class="h-1.5 rounded-full">
                    <MeterIndicator
                        class={meterColors[usageLevel(kind, value)]}
                    />
                </MeterTrack>
            </Meter>
        {/if}
    </div>
{/snippet}

{#snippet rate(value: number | null)}
    <TableCell
        class="flex items-center justify-end tabular-nums {value
            ? ''
            : 'text-muted-foreground'}"
    >
        {bandwidth(value)}
    </TableCell>
{/snippet}

{#snippet usage(row: ServiceRow | ContainerRow)}
    <TableCell
        class="flex items-center justify-end gap-3 tabular-nums"
        title={cpuTitle(row)}
    >
        {@render meter("CPU share", "cpu", row.cpuPercent)}
        <span class="w-14 text-right">{percent(row.cpu)}</span>
    </TableCell>
    <TableCell
        class="flex items-center justify-end gap-3 tabular-nums"
        title={memoryTitle(row)}
    >
        {@render meter("Memory share", "memory", row.memoryPercent)}
        <span class="w-20 text-right">{bytes(row.memory)}</span>
    </TableCell>
    {@render rate(row.networkIn)}
    {@render rate(row.networkOut)}
{/snippet}

<Frame class="xl:min-h-0 xl:flex-1">
    <FrameHeader
        class="flex-row flex-wrap items-center justify-between gap-3"
    >
        <div class="flex items-center gap-3">
            <FrameTitle>Services</FrameTitle>
            <span class="text-xs text-muted-foreground">
                {services.length} services
            </span>
            {#if needAttention}<span
                    class="text-xs text-warning-foreground"
                >
                    {needAttention}
                    {needAttention === 1 ? "needs" : "need"} attention
                </span>{/if}
        </div>
        <Input
            aria-label="Filter services"
            placeholder="Filter services…"
            value={search}
            oninput={(event) => {
                search = event.currentTarget.value;
                viewport?.scrollTo({ top: 0 });
            }}
            class="max-w-64"
        />
    </FrameHeader>
    <FramePanel
        class="overflow-hidden p-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
    >
        {#if missingMetrics}<p
                class="border-b px-4 py-3 text-sm text-muted-foreground"
            >
                No per-service samples are available. Check the
                cluster's cAdvisor collector and service-label
                collection. Host charts remain available.
            </p>{/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the virtualized viewport.) -->
        <div
            bind:this={viewport}
            class="max-h-[60vh] overflow-auto xl:max-h-none xl:min-h-0 xl:flex-1"
            tabindex="0"
            role="region"
            aria-label="Services usage table"
        >
            <table
                class="grid w-full min-w-[67rem] text-sm"
                aria-rowcount={lines.length + 1}
            >
                <caption class="sr-only">
                    Current usage per service, problems first,
                    expandable to its containers. CPU 100% equals one
                    core.
                </caption>
                <TableHeader
                    class="sticky top-0 z-10 grid bg-background"
                >
                    <TableRow class="grid h-10 {tableGrid}">
                        {#each table.getHeaderGroups()[0]?.headers ?? [] as header (header.id)}
                            {@const sorted =
                                header.column.getIsSorted()}
                            {@const numeric = numericColumns.includes(
                                header.id,
                            )}
                            <TableHead
                                class="flex h-full min-w-0 items-center {numeric
                                    ? 'justify-end'
                                    : ''}"
                                title={columnHints.get(header.id)}
                                aria-sort={sorted === "desc"
                                    ? "descending"
                                    : sorted === "asc"
                                      ? "ascending"
                                      : "none"}
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    class="h-8 px-2 text-sm font-medium text-muted-foreground hover:text-foreground {numeric
                                        ? '-mr-2 flex-row-reverse'
                                        : '-ml-2'}"
                                    onclick={header.column.getToggleSortingHandler()}
                                >
                                    {header.column.columnDef.header}
                                    {#if sorted === "desc"}
                                        <ArrowDown class="size-3" />
                                    {:else if sorted === "asc"}
                                        <ArrowUp class="size-3" />
                                    {/if}
                                </Button>
                            </TableHead>
                        {/each}
                    </TableRow>
                </TableHeader>
                <TableBody
                    class="relative block"
                    style={`height: ${$virtualizer.getTotalSize()}px`}
                >
                    {#each items as item (item.key)}
                        {@const line = lines[item.index]}
                        {#if line?.container}
                            {@const container = line.container}
                            {@const health = containerHealth(
                                container,
                                Date.now(),
                            )}
                            <TableRow
                                aria-rowindex={item.index + 2}
                                aria-level={2}
                                class="absolute inset-x-0 top-0 grid h-10 {tableGrid} bg-muted/30"
                                style={`transform: translateY(${item.start}px)`}
                            >
                                <TableCell
                                    class="flex min-w-0 items-center gap-2 py-0"
                                >
                                    <!-- Lines the dot up with the service's, past its caret. -->
                                    <span
                                        class="-ml-2 size-8 shrink-0 sm:size-7"
                                    ></span>
                                    {@render dot(health)}
                                    <div class="min-w-0">
                                        <div
                                            class="truncate font-mono text-xs"
                                            title={container.name}
                                        >
                                            {container.name ||
                                                container.id.slice(
                                                    0,
                                                    12,
                                                )}
                                        </div>
                                        <div
                                            class="mt-0.5 truncate text-xs {reasonColors[
                                                health.level
                                            ]}"
                                            title={container.startedAt
                                                ? `Started ${new Date(container.startedAt).toLocaleString()}`
                                                : undefined}
                                        >
                                            {health.reason}
                                        </div>
                                    </div>
                                </TableCell>
                                {#if showCluster}<TableCell
                                    ></TableCell>{/if}
                                <TableCell
                                    class="flex min-w-0 items-center text-muted-foreground"
                                    title={container.machineName}
                                >
                                    <span class="truncate">
                                        {container.machineName}
                                    </span>
                                </TableCell>
                                {@render usage(container)}
                            </TableRow>
                        {:else if line}
                            {@const row = line.service}
                            {@const health = healthOf(row)}
                            <TableRow
                                aria-rowindex={item.index + 2}
                                aria-level={1}
                                class="absolute inset-x-0 top-0 grid h-10 {tableGrid} {row
                                    .containers.length
                                    ? 'cursor-pointer'
                                    : ''}"
                                style={`transform: translateY(${item.start}px)`}
                                onpointerenter={() =>
                                    (hovered = row.key)}
                                onpointerleave={() => (hovered = "")}
                                onclick={() => {
                                    if (row.containers.length)
                                        toggle(row.key);
                                }}
                            >
                                <TableCell
                                    class="flex min-w-0 items-center gap-2 py-0"
                                >
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        class="-ml-2 shrink-0"
                                        aria-label={`${expanded(row.key) ? "Hide" : "Show"} containers of ${row.name}`}
                                        aria-expanded={expanded(
                                            row.key,
                                        )}
                                        disabled={!row.containers
                                            .length}
                                        onclick={(
                                            event: MouseEvent,
                                        ) => {
                                            event.stopPropagation();
                                            toggle(row.key);
                                        }}
                                    >
                                        <ChevronRight
                                            class="size-4 transition-transform {expanded(
                                                row.key,
                                            )
                                                ? 'rotate-90'
                                                : ''}"
                                        />
                                    </Button>
                                    {@render dot(health)}
                                    <div class="min-w-0">
                                        <div
                                            class="truncate font-medium"
                                            title={row.name}
                                        >
                                            {#if row.resource}<a
                                                    class="underline-offset-4 hover:underline focus-visible:underline"
                                                    href={resourceHref(
                                                        row.resource
                                                            .projectId,
                                                        row.resource
                                                            .resourceId,
                                                    )}
                                                    onclick={(
                                                        event,
                                                    ) =>
                                                        event.stopPropagation()}
                                                >
                                                    {row.name}
                                                </a>{:else}{row.name}{/if}
                                        </div>
                                        {#if health.level !== "ok"}
                                            <div
                                                class="mt-0.5 truncate text-xs {reasonColors[
                                                    health.level
                                                ]}"
                                                title={health.reason}
                                            >
                                                {health.reason}
                                            </div>
                                        {/if}
                                    </div>
                                </TableCell>
                                {#if showCluster}<TableCell
                                        class="flex min-w-0 items-center text-muted-foreground"
                                        title={row.clusterName}
                                    >
                                        <span class="truncate">
                                            {row.clusterName}
                                        </span>
                                    </TableCell>{/if}
                                <TableCell
                                    class="flex min-w-0 items-center text-muted-foreground"
                                    title={row.machines.join(", ")}
                                >
                                    <span class="truncate">
                                        {row.machines.length > 1
                                            ? `${row.machines.length} machines`
                                            : (row.machines[0] ??
                                              "Unscheduled")}
                                    </span>
                                </TableCell>
                                {@render usage(row)}
                            </TableRow>
                        {/if}
                    {/each}
                    {#if !lines.length}<TableRow
                            class="grid h-32 {tableGrid}"
                        >
                            <TableCell
                                colspan={columns.length}
                                class="col-span-full flex items-center justify-center text-center text-muted-foreground"
                            >
                                {search
                                    ? "No services match your search."
                                    : "No services for the selected clusters and machines."}
                            </TableCell>
                        </TableRow>{/if}
                </TableBody>
            </table>
        </div>
    </FramePanel>
</Frame>
