<script lang="ts">
    import { ago } from "$lib/format";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
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
        percent,
        seriesColor,
        type ContainerRow,
        type ServiceRow,
    } from "$lib/observability";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
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
    import { untrack } from "svelte";
    import { SvelteSet } from "svelte/reactivity";
    import MetricChart from "./metric-chart.svelte";

    let {
        data,
        search = $bindable(""),
        start,
        end,
        expandAll = false,
    }: {
        data: ServiceRow[];
        search?: string;
        start: number;
        end: number;
        expandAll?: boolean;
    } = $props();

    let sorting = $state<SortingState>([{ id: "cpu", desc: true }]);

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
        { id: "running", accessorKey: "running", header: "Status" },
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
            header: "Network ↓",
            sortUndefined: "last",
        },
        {
            id: "networkOut",
            accessorFn: (row) => row.networkOut ?? undefined,
            header: "Network ↑",
            sortUndefined: "last",
        },
        { id: "trend", header: "CPU trend", enableSorting: false },
    ];

    const table = $derived.by(() => {
        const instance = createTable<ServiceRow>({
            data,
            columns,
            state: {},
            onStateChange: () => {},
            renderFallbackValue: "—",
            onSortingChange: (update) => {
                sorting = functionalUpdate(update, sorting);
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
        };

        instance.setOptions((options) => ({ ...options, state }));

        return instance;
    });

    const services = $derived(table.getRowModel().rows);

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

    const rowHeight = 52;

    // Share flexible tracks across the header and virtual rows, preserving readable minimums.
    const tableGrid =
        "grid-cols-[minmax(15rem,2fr)_minmax(7rem,1fr)_minmax(9rem,1fr)_minmax(12rem,1fr)_minmax(8rem,1fr)_minmax(10rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)]";

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
</script>

{#snippet issues(
    restarts: number,
    oomKilled: number,
    unhealthy: number,
)}
    {#if restarts}<Badge
            size="sm"
            variant="warning"
            title="Restarts since the container was created"
        >
            {restarts} restart{restarts === 1 ? "" : "s"}
        </Badge>{/if}
    {#if oomKilled}<Badge
            size="sm"
            variant="error"
            title="Last exit was an out-of-memory kill"
        >
            OOM killed
        </Badge>{/if}
    {#if unhealthy}<Badge size="sm" variant="error">
            Unhealthy
        </Badge>{/if}
{/snippet}

{#snippet usage(row: ServiceRow | ContainerRow)}
    <TableCell class="tabular-nums">
        {percent(row.cpu)}{#if row.cpuLimit}<span
                class="ml-1 text-xs text-muted-foreground"
            >
                / {row.cpuLimit.toLocaleString()} cores
            </span>{/if}
    </TableCell>
    <TableCell
        class="tabular-nums"
        title={row.memoryLimit
            ? `Limit ${bytes(row.memoryLimit)}`
            : undefined}
    >
        {bytes(row.memory)}
        <span
            class="ml-1 text-xs {row.memoryPercent !== null &&
            row.memoryPercent >= 90
                ? 'text-destructive-foreground'
                : 'text-muted-foreground'}"
        >
            {percent(row.memoryPercent)}
        </span>
    </TableCell>
    <TableCell class="tabular-nums">
        {bandwidth(row.networkIn)}
    </TableCell>
    <TableCell class="tabular-nums">
        {bandwidth(row.networkOut)}
    </TableCell>
    <TableCell>
        <MetricChart
            compact
            {start}
            {end}
            series={[
                {
                    key: row.key,
                    label: row.name,
                    color: seriesColor(row.name),
                    points: row.trend,
                },
            ]}
        />
    </TableCell>
{/snippet}

<Frame>
    <FrameHeader
        class="flex-row flex-wrap items-center justify-between gap-3"
    >
        <div class="flex items-center gap-3">
            <FrameTitle>Services</FrameTitle>
            <span class="text-xs text-muted-foreground">
                {services.length} services
            </span>
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
    <FramePanel class="overflow-hidden p-0">
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
            class="max-h-[60vh] overflow-auto"
            tabindex="0"
            role="region"
            aria-label="Services usage table"
        >
            <table
                class="grid w-full min-w-[82rem] text-sm"
                aria-rowcount={lines.length + 1}
            >
                <caption class="sr-only">
                    Current usage per service, expandable to its
                    containers. CPU 100% equals one core. Memory
                    percentage is of the memory limit, or of machine
                    memory for unlimited containers.
                </caption>
                <TableHeader
                    class="sticky top-0 z-10 grid bg-background"
                >
                    <TableRow class="grid h-11 {tableGrid}">
                        {#each table.getHeaderGroups()[0]?.headers ?? [] as header (header.id)}
                            <TableHead
                                class="flex h-full min-w-0 items-center"
                                aria-sort={sorting[0]?.id ===
                                header.id
                                    ? sorting[0].desc
                                        ? "descending"
                                        : "ascending"
                                    : "none"}
                            >
                                {#if header.column.getCanSort()}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        class="-ml-2 h-8 px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
                                        onclick={header.column.getToggleSortingHandler()}
                                    >
                                        {header.column.columnDef
                                            .header}
                                        {sorting[0]?.id === header.id
                                            ? sorting[0].desc
                                                ? "↓"
                                                : "↑"
                                            : "↕"}
                                    </Button>
                                {:else}{header.column.columnDef
                                        .header}{/if}
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
                            <TableRow
                                aria-rowindex={item.index + 2}
                                aria-level={2}
                                class="absolute inset-x-0 top-0 grid h-[52px] {tableGrid} bg-muted/30"
                                style={`transform: translateY(${item.start}px)`}
                            >
                                <TableCell
                                    class="truncate pl-10 font-mono text-xs"
                                    title={container.name}
                                >
                                    {container.name ||
                                        container.id.slice(0, 12)}
                                </TableCell>
                                <TableCell></TableCell>
                                <TableCell
                                    class="truncate"
                                    title={container.machineName}
                                >
                                    {container.machineName}
                                </TableCell>
                                <TableCell>
                                    <div
                                        class="flex flex-wrap items-center gap-1"
                                    >
                                        <span
                                            class="text-xs {container.running
                                                ? 'text-muted-foreground'
                                                : 'text-warning-foreground'}"
                                            title={container.startedAt
                                                ? `Started ${new Date(container.startedAt).toLocaleString()}`
                                                : undefined}
                                        >
                                            {container.state}{container.running &&
                                            container.startedAt
                                                ? ` · started ${ago(container.startedAt, Date.now())}`
                                                : ""}
                                        </span>
                                        {@render issues(
                                            container.restarts,
                                            container.oomKilled,
                                            container.health ===
                                                "unhealthy"
                                                ? 1
                                                : 0,
                                        )}
                                    </div>
                                </TableCell>
                                {@render usage(container)}
                            </TableRow>
                        {:else if line}
                            {@const row = line.service}
                            <TableRow
                                aria-rowindex={item.index + 2}
                                aria-level={1}
                                class="absolute inset-x-0 top-0 grid h-[52px] {tableGrid} {row
                                    .containers.length
                                    ? 'cursor-pointer'
                                    : ''}"
                                style={`transform: translateY(${item.start}px)`}
                                onclick={() => {
                                    if (row.containers.length)
                                        toggle(row.key);
                                }}
                            >
                                <TableCell class="font-medium">
                                    <div
                                        class="flex min-w-0 items-center gap-1"
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
                                        <span
                                            class="truncate"
                                            title={row.name}
                                        >
                                            {#if row.href}<a
                                                    class="underline-offset-4 hover:underline focus-visible:underline"
                                                    href={row.href}
                                                    onclick={(
                                                        event,
                                                    ) =>
                                                        event.stopPropagation()}
                                                >
                                                    {row.name}
                                                </a>{:else}{row.name}{/if}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell
                                    class="truncate"
                                    title={row.clusterName}
                                >
                                    {row.clusterName}
                                </TableCell>
                                <TableCell
                                    class="truncate"
                                    title={row.machines.join(", ")}
                                >
                                    {row.machines.length > 1
                                        ? `${row.machines.length} machines`
                                        : (row.machines[0] ??
                                          "Unscheduled")}
                                </TableCell>
                                <TableCell>
                                    <div
                                        class="flex flex-wrap items-center gap-1"
                                    >
                                        <span
                                            class="text-xs tabular-nums {row.running <
                                                row.containers
                                                    .length ||
                                            !row.containers.length
                                                ? 'text-warning-foreground'
                                                : 'text-muted-foreground'}"
                                        >
                                            {row.running}/{row
                                                .containers.length} running
                                        </span>
                                        {@render issues(
                                            row.restarts,
                                            row.oomKilled,
                                            row.unhealthy,
                                        )}
                                    </div>
                                </TableCell>
                                {@render usage(row)}
                            </TableRow>
                        {/if}
                    {/each}
                    {#if !lines.length}<TableRow
                            class="grid h-32 {tableGrid}"
                        >
                            <TableCell
                                colspan={9}
                                class="col-span-9 flex items-center justify-center text-center text-muted-foreground"
                            >
                                {search
                                    ? "No services match your search."
                                    : "No services for the selected clusters and machines."}
                            </TableCell>
                        </TableRow>{/if}
                </TableBody>
            </table>
        </div>
        <p class="border-t px-4 py-3 text-xs text-muted-foreground">
            Live usage · expand a service for its containers · 100%
            CPU = 1 core · memory % is of the limit, or of machine
            memory when unlimited · restarts count since each
            container was created
        </p>
    </FramePanel>
</Frame>
