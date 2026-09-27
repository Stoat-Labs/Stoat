<script lang="ts">
    import { browser } from "$app/environment";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import ServicesTable from "$lib/components/observability/services-table.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "$lib/components/ui/empty";
    import { Frame, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { assembleCluster, bandwidth, bytes, chartSeries, chartSeriesRatio, machineList, machineValue, percent, serviceRows, sumMachines, type ClusterData } from "$lib/observability";
    import { orpc } from "$lib/orpc";
    import { metricNames, rangePresets } from "@stoat/api/observability";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import { createQueries, createQuery } from "@tanstack/svelte-query";
    import { ChartGroup } from "layerchart";
    import { parseAsArrayOf, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs-svelte";

    const filters = useQueryStates({ clusters: parseAsArrayOf(parseAsString), range: parseAsStringLiteral(rangePresets).withDefault("1h"), from: parseAsInteger, to: parseAsInteger, machine: parseAsString.withDefault(""), q: parseAsString.withDefault("") }, { shallow: true, scroll: false });

    // A custom from/to pair in the URL overrides the preset.
    const custom = $derived(filters.from.current && filters.to.current && filters.to.current > filters.from.current ? { from: filters.from.current, to: filters.to.current } : null);

    let customOpen = $state(false);

    let draftFrom = $state("");

    let draftTo = $state("");

    // datetime-local wants local wall-clock time without a zone.
    function toLocalInput(seconds: number) {
        const date = new Date(seconds * 1000);
        date.setMinutes(date.getMinutes() - date.getTimezoneOffset());

        return date.toISOString().slice(0, 16);
    }

    function formatRange(range: { from: number; to: number }) {
        const format = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

        return `${format(range.from)} – ${format(range.to)}`;
    }

    function openCustom(open: boolean) {
        customOpen = open;

        if (!open) return;
        const now = Math.floor(Date.now() / 1000);
        draftFrom = toLocalInput(custom?.from ?? now - 3600);
        draftTo = toLocalInput(custom?.to ?? now);
    }

    const draftValid = $derived(Boolean(draftFrom && draftTo) && new Date(draftTo).getTime() - new Date(draftFrom).getTime() >= 60_000);

    function applyCustom(event: SubmitEvent) {
        event.preventDefault();

        if (!draftValid) return;
        void filters.set({ from: Math.floor(new Date(draftFrom).getTime() / 1000), to: Math.floor(new Date(draftTo).getTime() / 1000) });
        customOpen = false;
    }

    let paused = $state(false);

    let hoveredMachine = $state("");

    const list = createQuery(() => orpc.cluster.listObservableClusters.queryOptions({ enabled: browser }));

    const clusters = $derived(list.data ?? []);

    const selected = $derived(filters.clusters.current ?? (clusters[0] ? [clusters[0].id] : []));

    const selection = $derived(clusters.filter((cluster) => selected.includes(cluster.id)));

    // Live refresh only makes sense for ranges ending now; a custom range is a fixed window.
    const options = $derived({ enabled: browser, refetchInterval: paused || custom ? (false as const) : 30_000, retry: false, staleTime: 25_000 });

    const machineQueries = createQueries(() => ({ queries: selection.map((cluster) => orpc.cluster.getObservabilityMachines.queryOptions({ input: { clusterId: cluster.id }, ...options })) }));

    const serviceQueries = createQueries(() => ({ queries: selection.map((cluster) => orpc.cluster.getObservabilityServices.queryOptions({ input: { clusterId: cluster.id }, ...options })) }));

    // One query per metric so each chart renders as soon as its own data arrives.
    const metricQueries = createQueries(() => ({ queries: selection.flatMap((cluster) => metricNames.map((name) => orpc.cluster.getObservabilityMetric.queryOptions({ input: { clusterId: cluster.id, name, range: custom ?? filters.range.current }, ...options }))) }));

    const queries = $derived([...machineQueries, ...serviceQueries, ...metricQueries]);

    const data = $derived(selection.flatMap((cluster, index): ClusterData[] => {
        const machines = machineQueries[index];
        const services = serviceQueries[index];

        return machines && services ? [assembleCluster(cluster, machines, services, metricQueries.slice(index * metricNames.length, (index + 1) * metricNames.length))] : [];
    }));

    const machines = $derived(machineList(data));

    const visibleMachines = $derived(machines.filter((machine) => !filters.machine.current || machine.key === filters.machine.current));

    const services = $derived(serviceRows(data).filter((row) => !filters.machine.current || `${row.clusterId}:${row.machineId}` === filters.machine.current));

    const machineOptions = $derived([{ value: "", label: "All machines" }, ...machines.map((machine) => ({ value: machine.key, label: `${machine.cluster.name} / ${machine.name}` }))]);

    // Show the skeleton only for the initial request; refetches keep the charts mounted.
    const pending = $derived(!data.some((cluster) => cluster.available) && queries.some((query) => query.isPending));

    const fetching = $derived(queries.some((query) => query.isFetching));

    const start = $derived(Math.min(...data.map((cluster) => cluster.start), Infinity));

    const end = $derived(Math.max(...data.map((cluster) => cluster.end), 0));

    const memory = $derived(sumMachines(visibleMachines, "memory"));

    const cores = $derived(sumMachines(visibleMachines, "cores"));

    const memoryTotal = $derived(sumMachines(visibleMachines, "memoryTotal"));

    const disk = $derived(sumMachines(visibleMachines, "disk"));

    const diskTotal = $derived(sumMachines(visibleMachines, "diskTotal"));

    const reporting = $derived(visibleMachines.filter((machine) => machineValue(machine, "cpu") !== null).length);

    useHeaderActions(toolbar);

    function toggleCluster(id: string) {
        void filters.set({ clusters: selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id], machine: "" });
    }
</script>

<svelte:head><title>Observability · Stoat</title></svelte:head>

{#snippet toolbar()}
    <div class="flex flex-wrap items-center justify-end gap-2">
        <Popover>
            <PopoverTrigger class={buttonVariants({ variant: "outline", size: "sm" })} disabled={list.isPending}>
                Clusters: {selection.length === 1 ? selection[0].name : `${selection.length} selected`}<ChevronDown class="ml-2 size-4" />
            </PopoverTrigger>
            <PopoverContent align="start" class="w-72 p-3">
                <div class="max-h-72 w-full space-y-1 overflow-auto">
                    <p class="px-2 py-1 text-xs font-medium text-muted-foreground">Select clusters</p>
                    {#each clusters as cluster (cluster.id)}
                        <label class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"><Checkbox checked={selected.includes(cluster.id)} onCheckedChange={() => toggleCluster(cluster.id)} /><span class="truncate">{cluster.name}</span></label>
                    {/each}
                </div>
            </PopoverContent>
        </Popover>
        <Select value={filters.machine.current} items={machineOptions} onValueChange={(value) => { filters.machine.current = value ?? ""; }}>
            <SelectTrigger aria-label="Filter by machine" class="w-52"><SelectValue placeholder="All machines" /></SelectTrigger>
            <SelectContent>{#each machineOptions as option (option.value)}<SelectItem value={option.value} label={option.label} />{/each}</SelectContent>
        </Select>
        <div class="flex flex-wrap items-center gap-1 rounded-lg border p-0.5" role="group" aria-label="Time range">
            {#each rangePresets as range (range)}<Button variant={!custom && filters.range.current === range ? "secondary" : "ghost"} size="sm" class="h-7 px-2.5" aria-pressed={!custom && filters.range.current === range} onclick={() => void filters.set({ range, from: null, to: null })}>{range}</Button>{/each}
            <Popover bind:open={() => customOpen, openCustom}>
                <PopoverTrigger class={buttonVariants({ variant: custom ? "secondary" : "ghost", size: "sm", class: "h-7 px-2.5" })} aria-pressed={!!custom}>{custom ? formatRange(custom) : "Custom"}<ChevronDown class="ml-1 size-4" /></PopoverTrigger>
                <PopoverContent align="end" class="w-72 p-3">
                    <form class="space-y-3" onsubmit={applyCustom}>
                        <div class="space-y-1.5"><Label for="range-from">From</Label><Input id="range-from" type="datetime-local" bind:value={draftFrom} max={draftTo} required /></div>
                        <div class="space-y-1.5"><Label for="range-to">To</Label><Input id="range-to" type="datetime-local" bind:value={draftTo} min={draftFrom} required /></div>
                        {#if draftFrom && draftTo && !draftValid}<p class="text-xs text-destructive" role="alert">The range must span at least one minute.</p>{/if}
                        <Button type="submit" size="sm" class="w-full" disabled={!draftValid}>Apply range</Button>
                    </form>
                </PopoverContent>
            </Popover>
        </div>
        <Button variant="outline" size="sm" aria-pressed={paused} disabled={!!custom} onclick={() => (paused = !paused)}>{custom ? "Fixed range" : paused ? "Paused" : "Live · 30s"}</Button>
        <Button variant="outline" size="icon-sm" aria-label="Refresh metrics" disabled={fetching || !selection.length} onclick={() => { for (const query of queries) void query.refetch(); }}><RefreshCw class={fetching ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} /></Button>
    </div>
{/snippet}

<div class="min-w-0 w-full space-y-6 py-6">
    {#if list.isError}<Alert variant="error"><AlertDescription>Could not load clusters. <button class="underline" onclick={() => list.refetch()}>Try again</button></AlertDescription></Alert>{/if}
    {#if list.isPending || pending}
        <Skeleton loading loading-label="Loading cluster metrics">
            <div class="space-y-4">
                <Frame>
                    <FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>CPU per machine</FrameTitle><span class="text-xs text-muted-foreground">hover to highlight · click a machine to filter</span></FrameHeader>
                    <FramePanel class="min-w-0 p-4"><div class="h-48 min-w-0 w-full">Loading chart</div></FramePanel>
                </Frame>
                <div class="grid gap-4 xl:grid-cols-2">
                    {#each ["Memory by machine", "Disk usage · root filesystem", "Network · receive / send", "Disk I/O · read / write"] as title (title)}<Frame class="min-w-0"><FrameHeader><FrameTitle>{title}</FrameTitle></FrameHeader><FramePanel class="min-w-0 p-4"><div class="h-48 min-w-0 w-full">Loading chart</div></FramePanel></Frame>{/each}
                </div>
                <Frame><FrameHeader><FrameTitle>Services</FrameTitle></FrameHeader><FramePanel class="p-4"><p class="text-sm text-muted-foreground">Loading service placements</p></FramePanel></Frame>
            </div>
        </Skeleton>
    {/if}
    {#each data as cluster (cluster.id)}
        {#if cluster.reason}
            <Alert variant="warning"><AlertDescription><span class="font-medium">{cluster.name}:</span> {cluster.reason === "uninitialized" ? "Initialize monitoring to collect metrics." : "Monitoring is unreachable. Other clusters remain available."} <a class="underline underline-offset-2" href={`/clusters/${cluster.id}`}>Open cluster</a></AlertDescription></Alert>
        {:else if cluster.unavailable.length}
            <Alert variant="info"><AlertDescription>{cluster.name}: some metrics are unavailable ({cluster.unavailable.join(", ")}). Available charts are shown below.</AlertDescription></Alert>
        {/if}
    {/each}
    {#if !list.isPending && !selection.length}
        <Empty><EmptyHeader><EmptyTitle>{clusters.length ? "Select a cluster" : "No clusters yet"}</EmptyTitle><EmptyDescription>{clusters.length ? "Choose one or more clusters to view their machines and services." : "Add a cluster and initialize monitoring to see system usage."}</EmptyDescription></EmptyHeader><a class={buttonVariants({ variant: "outline" })} href="/clusters">Open clusters</a></Empty>
    {:else if data.some((cluster) => cluster.available)}
        <ChartGroup pointer={{ tooltip: false }} brush={false} domain={false} series={false}>
        <Frame>
            <FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>CPU per machine</FrameTitle><span class="text-xs text-muted-foreground tabular-nums"><span class="font-medium text-foreground">{percent(sumMachines(visibleMachines, "cpu"))}</span> of {percent(cores === null ? null : cores * 100)}{reporting < visibleMachines.length ? ` · ${reporting} / ${visibleMachines.length} reporting` : ""}</span></FrameHeader>
            <FramePanel class="min-w-0 p-4">
                <MetricChart series={chartSeries(visibleMachines, "cpu")} {start} {end} bind:hoveredMachine />
                <div class="mt-3 flex flex-wrap gap-2">
                    {#each machines as machine (machine.key)}
                        <Button variant={filters.machine.current === machine.key ? "secondary" : "ghost"} size="sm" class="gap-2 text-xs" style={`opacity: ${hoveredMachine && hoveredMachine !== machine.key ? 0.4 : 1}`} onpointerenter={() => (hoveredMachine = machine.key)} onpointerleave={() => (hoveredMachine = "")} onfocus={() => (hoveredMachine = machine.key)} onblur={() => (hoveredMachine = "")} aria-pressed={filters.machine.current === machine.key} onclick={() => (filters.machine.current = filters.machine.current === machine.key ? "" : machine.key)}>
                            <span class="size-2 rounded-full" style:background={machine.color}></span>
                            {machine.cluster.name} / {machine.name}
                            <span class="font-semibold tabular-nums">{percent(machineValue(machine, "cpu"))}</span>
                        </Button>
                    {/each}
                </div>
            </FramePanel>
        </Frame>

        <div class="grid gap-4 xl:grid-cols-2">
            <Frame class="min-w-0"><FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>Memory by machine</FrameTitle><span class="text-xs text-muted-foreground tabular-nums"><span class="font-medium text-foreground">{bytes(memory)}</span> of {bytes(memoryTotal)}</span></FrameHeader><FramePanel class="min-w-0 p-4"><MetricChart series={chartSeries(visibleMachines, "memory")} {start} {end} unit="bytes" bind:hoveredMachine /><div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">{#each visibleMachines as machine (machine.key)}<span class="flex items-center gap-2 text-xs" style:opacity={hoveredMachine && hoveredMachine !== machine.key ? 0.4 : 1}><span class="size-2 rounded-full" style:background={machine.color}></span>{machine.cluster.name} / {machine.name}</span>{/each}</div></FramePanel></Frame>
             <Frame class="min-w-0"><FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>Disk usage · root filesystem</FrameTitle><span class="text-xs text-muted-foreground tabular-nums"><span class="font-medium text-foreground">{disk !== null && diskTotal ? percent(100 * disk / diskTotal) : "—"}</span> · {bytes(disk)} of {bytes(diskTotal)}</span></FrameHeader><FramePanel class="min-w-0 p-4"><MetricChart series={chartSeriesRatio(visibleMachines, "disk", "diskTotal")} {start} {end} max={100} bind:hoveredMachine /><div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">{#each visibleMachines as machine (machine.key)}<span class="flex items-center gap-2 text-xs" style:opacity={hoveredMachine && hoveredMachine !== machine.key ? 0.4 : 1}><span class="size-2 rounded-full" style:background={machine.color}></span>{machine.cluster.name} / {machine.name}</span>{/each}</div></FramePanel></Frame>
            <Frame class="min-w-0"><FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>Network · receive / send</FrameTitle><span class="text-xs text-muted-foreground tabular-nums">↓ <span class="font-medium text-foreground">{bandwidth(sumMachines(visibleMachines, "networkIn"))}</span> · ↑ <span class="font-medium text-foreground">{bandwidth(sumMachines(visibleMachines, "networkOut"))}</span></span></FrameHeader><FramePanel class="min-w-0 p-4"><MetricChart series={[...chartSeries(visibleMachines, "networkIn").map((item) => ({ ...item, label: `${item.label} receive` })), ...chartSeries(visibleMachines, "networkOut").map((item) => ({ ...item, label: `${item.label} send` }))]} {start} {end} unit="rate" bind:hoveredMachine /><p class="mt-2 text-xs text-muted-foreground">Solid: receive · dashed: send · bytes per second</p></FramePanel></Frame>
            <Frame class="min-w-0"><FrameHeader class="flex-row flex-wrap items-center justify-between gap-2"><FrameTitle>Disk I/O · read / write</FrameTitle><span class="text-xs text-muted-foreground tabular-nums">R <span class="font-medium text-foreground">{bandwidth(sumMachines(visibleMachines, "diskRead"))}</span> · W <span class="font-medium text-foreground">{bandwidth(sumMachines(visibleMachines, "diskWrite"))}</span></span></FrameHeader><FramePanel class="min-w-0 p-4"><MetricChart series={[...chartSeries(visibleMachines, "diskRead").map((item) => ({ ...item, label: `${item.label} read` })), ...chartSeries(visibleMachines, "diskWrite").map((item) => ({ ...item, label: `${item.label} write` }))]} {start} {end} unit="rate" bind:hoveredMachine /><p class="mt-2 text-xs text-muted-foreground">Solid: read · dashed: write · bytes per second</p></FramePanel></Frame>
        </div>
        </ChartGroup>
        <ServicesTable data={services} {start} {end} bind:search={() => filters.q.current, (value) => (filters.q.current = value)} />
        <p class="text-xs text-muted-foreground">Charts show the selected range; numbers show its latest sample. Gaps mean missing data. {pending || data.some((cluster) => !cluster.available) ? "Totals include reporting clusters only." : ""}</p>
    {/if}
</div>
