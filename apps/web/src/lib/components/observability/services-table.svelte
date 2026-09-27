<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { Frame, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
    import { bandwidth, bytes, percent, type ServiceRow } from "$lib/observability";
    import { createTable, functionalUpdate, getCoreRowModel, getFilteredRowModel, getSortedRowModel, type ColumnDef, type SortingState } from "@tanstack/table-core";
    import { createVirtualizer } from "@tanstack/svelte-virtual";
    import { untrack } from "svelte";
    import MetricChart from "./metric-chart.svelte";

    let { data, search = $bindable(""), start, end }: { data: ServiceRow[]; search?: string; start: number; end: number } = $props();

    let sorting = $state<SortingState>([{ id: "cpu", desc: true }]);

    let viewport = $state<HTMLDivElement>();

    const columns: ColumnDef<ServiceRow>[] = [
        { id: "name", accessorKey: "name", header: "Service" },
        { id: "clusterName", accessorKey: "clusterName", header: "Cluster" },
        { id: "machineName", accessorKey: "machineName", header: "Machine" },
        { id: "running", accessorKey: "running", header: "Containers" },
        { id: "cpu", accessorFn: (row) => row.cpu ?? undefined, header: "CPU", sortUndefined: "last" },
        { id: "memory", accessorFn: (row) => row.memory ?? undefined, header: "Memory", sortUndefined: "last" },
        { id: "networkIn", accessorFn: (row) => row.networkIn ?? undefined, header: "Network ↓", sortUndefined: "last" },
        { id: "networkOut", accessorFn: (row) => row.networkOut ?? undefined, header: "Network ↑", sortUndefined: "last" },
        { id: "trend", header: "CPU trend", enableSorting: false },
    ];

    const table = $derived.by(() => {
        const instance = createTable<ServiceRow>({
        data, columns,
        state: {},
        onStateChange: () => {}, renderFallbackValue: "—",
        onSortingChange: (update) => { sorting = functionalUpdate(update, sorting); viewport?.scrollTo({ top: 0 }); },
        getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(),
        getRowId: (row) => row.key, globalFilterFn: "includesString",
        });

        const state = { ...instance.initialState, sorting, globalFilter: search };
        instance.setOptions((options) => ({ ...options, state }));

        return instance;
    });

    const rows = $derived(table.getRowModel().rows);

    const virtualizer = createVirtualizer<HTMLDivElement, HTMLTableRowElement>({ count: 0, getScrollElement: () => viewport ?? null, estimateSize: () => 52, overscan: 8, scrollMargin: 44 });

    $effect(() => {
        // Synchronize the external virtualizer with the derived row model and mounted viewport.
        const current = rows;
        void viewport;
        untrack(() => $virtualizer.setOptions({ count: current.length, getItemKey: (index) => current[index]!.id }));
    });

    const items = $derived($virtualizer.getVirtualItems());

    const missingMetrics = $derived(data.length > 0 && data.every((row) => row.cpu === null && row.memory === null));
</script>

<Frame>
    <FrameHeader class="flex-row flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3"><FrameTitle>Services</FrameTitle><span class="text-xs text-muted-foreground">{rows.length} service placements</span></div>
        <Input aria-label="Filter services" placeholder="Filter services…" value={search} oninput={(event) => { search = event.currentTarget.value; viewport?.scrollTo({ top: 0 }); }} class="max-w-64" />
    </FrameHeader>
    <FramePanel class="overflow-hidden p-0">
        {#if missingMetrics}<p class="border-b px-4 py-3 text-sm text-muted-foreground">No per-service samples are available. Check the cluster's cAdvisor collector and service-label collection. Host charts remain available.</p>{/if}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the virtualized viewport.) -->
        <div bind:this={viewport} class="min-h-full overflow-auto" tabindex="0" role="region" aria-label="Services usage table">
            <table class="w-full min-w-[1120px] table-fixed text-sm" aria-rowcount={rows.length + 1}>
                <caption class="sr-only">Current service usage per machine. CPU 100% equals one core. Containers are running / observed; memory percentage is of host capacity.</caption>
                <colgroup><col class="w-56" /><col class="w-32" /><col class="w-36" /><col class="w-28" /><col class="w-24" /><col class="w-40" /><col class="w-32" /><col class="w-32" /><col class="w-28" /></colgroup>
                <TableHeader class="sticky top-0 z-10 bg-background">
                    <TableRow class="h-11">
                        {#each table.getHeaderGroups()[0]?.headers ?? [] as header (header.id)}
                            <TableHead aria-sort={sorting[0]?.id === header.id ? sorting[0].desc ? "descending" : "ascending" : "none"}>
                                {#if header.column.getCanSort()}
                                    <Button variant="ghost" size="sm" class="-ml-2 h-8 px-2 text-xs" onclick={header.column.getToggleSortingHandler()}>{header.column.columnDef.header} {sorting[0]?.id === header.id ? sorting[0].desc ? "↓" : "↑" : "↕"}</Button>
                                {:else}{header.column.columnDef.header}{/if}
                            </TableHead>
                        {/each}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {#if items[0]?.start > 44}<tr aria-hidden="true"><td colspan="9" style:height={`${items[0].start - 44}px`}></td></tr>{/if}
                    {#each items as item (item.key)}
                        {@const row = rows[item.index].original}
                        <TableRow aria-rowindex={item.index + 2} class="h-[52px]">
                            <TableCell class="truncate font-medium" title={row.name}>
                                {#if row.href}<a class="underline-offset-4 hover:underline focus-visible:underline" href={row.href}>{row.name}</a>{:else}{row.name}{/if}
                            </TableCell>
                            <TableCell class="truncate" title={row.clusterName}>{row.clusterName}</TableCell>
                            <TableCell class="truncate" title={row.machineName}>{row.machineName}</TableCell>
                            <TableCell class="tabular-nums"><span class={row.running < row.containers ? "text-warning-foreground" : "text-muted-foreground"}>{row.running}/{row.containers}</span></TableCell>
                            <TableCell class="tabular-nums">{percent(row.cpu)}</TableCell>
                            <TableCell class="tabular-nums">{bytes(row.memory)} <span class="ml-1 text-xs text-muted-foreground">{percent(row.memoryPercent)}</span></TableCell>
                            <TableCell class="tabular-nums">{bandwidth(row.networkIn)}</TableCell>
                            <TableCell class="tabular-nums">{bandwidth(row.networkOut)}</TableCell>
                            <TableCell><MetricChart compact {start} {end} series={[{ key: row.key, label: row.name, color: "var(--chart-1)", points: row.trend }]} /></TableCell>
                        </TableRow>
                    {/each}
                    {#if items.length}<tr aria-hidden="true"><td colspan="9" style:height={`${Math.max(0, $virtualizer.getTotalSize() - (items.at(-1)!.end - 44))}px`}></td></tr>{/if}
                    {#if !rows.length}<TableRow><TableCell colspan={9} class="h-32 text-center text-muted-foreground">{search ? "No services match your search." : "No services for the selected clusters and machines."}</TableCell></TableRow>{/if}
                </TableBody>
            </table>
        </div>
        <p class="border-t px-4 py-3 text-xs text-muted-foreground">Live usage · 100% CPU = 1 core · memory % is of machine capacity · containers: running / observed</p>
    </FramePanel>
</Frame>
