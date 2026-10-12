<script lang="ts">
    import { browser } from "$app/environment";
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import HttpBreakdown from "$lib/components/observability/http-breakdown.svelte";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        Popover,
        PopoverContent,
        PopoverTrigger,
    } from "$lib/components/ui/popover";
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
        bytes,
        count,
        duration,
        nameColors,
        percent,
        seriesColor,
        unpackMetric,
        type ChartSeries,
    } from "$lib/observability";
    import { orpc } from "$lib/api/orpc";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import {
        httpTrafficMetricNames,
        type HttpBreakdown as Breakdown,
        type HttpMetricName,
    } from "@stoat/api/observability";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsArrayOf,
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";

    const range = useObservabilityRange();

    syncMetricCharts();

    const filters = useQueryStates(
        {
            clusters: parseAsArrayOf(parseAsString),
            // Service IDs; empty means every service with a hostname.
            services: parseAsArrayOf(parseAsString).withDefault([]),
            paused: parseAsBoolean.withDefault(false),
        },
        { shallow: true, scroll: false },
    );

    const list = createQuery(() =>
        orpc.cluster.listObservableClusters.queryOptions({
            enabled: browser,
        }),
    );

    const clusters = $derived(list.data ?? []);

    // Without an explicit selection, open on a cluster with monitoring when one exists.
    const defaultCluster = $derived(
        clusters.find((cluster) => cluster.monitored) ?? clusters[0],
    );

    const selected = $derived(
        filters.clusters.current ??
            (defaultCluster ? [defaultCluster.id] : []),
    );

    const selection = $derived(
        clusters.filter((cluster) => selected.includes(cluster.id)),
    );

    // Only clusters with monitoring are queried; the rest would only answer "set up monitoring first".
    const monitoredSelection = $derived(
        selection.filter((cluster) => cluster.monitored),
    );

    const unmonitoredSelection = $derived(
        selection.filter((cluster) => !cluster.monitored),
    );

    const options = $derived({
        enabled: browser,
        refetchInterval:
            filters.paused.current || range.custom
                ? (false as const)
                : 30_000,
        retry: false,
        staleTime: 25_000,
    });

    const inventories = createQueries(() => ({
        queries: monitoredSelection.map((cluster) =>
            orpc.cluster.getObservabilityServices.queryOptions({
                input: { clusterId: cluster.id },
                ...options,
            }),
        ),
    }));

    const serviceInfo = $derived(
        new Map(
            inventories.flatMap((query) =>
                (query.data ?? []).map((service) => [
                    service.id,
                    service,
                ]),
            ),
        ),
    );

    const colors = $derived(
        nameColors(
            [...serviceInfo.values()].map((service) => service.name),
        ),
    );

    function serviceName(id: string) {
        return serviceInfo.get(id)?.name ?? id;
    }

    function serviceColor(id: string) {
        const name = serviceName(id);

        return colors.get(name) ?? seriesColor(name);
    }

    type Scope = {
        cluster: (typeof clusters)[number];
        /** Undefined charts every service with a hostname. */
        serviceIds: string[] | undefined;
    };

    // A service filter only scopes the clusters it has services in; the others are left out.
    const scopes = $derived(
        monitoredSelection.flatMap((cluster, index): Scope[] => {
            if (!filters.services.current.length)
                return [{ cluster, serviceIds: undefined }];

            const ids = (inventories[index]?.data ?? []).flatMap(
                (service) =>
                    filters.services.current.includes(service.id)
                        ? [service.id]
                        : [],
            );

            return ids.length ? [{ cluster, serviceIds: ids }] : [];
        }),
    );

    const charts = createQueries(() => ({
        queries: scopes.flatMap(({ cluster, serviceIds }) =>
            httpTrafficMetricNames.map((name) =>
                orpc.cluster.getObservabilityMetric.queryOptions({
                    input: {
                        clusterId: cluster.id,
                        name,
                        range: range.value,
                        serviceIds,
                    },
                    select: unpackMetric,
                    ...options,
                }),
            ),
        ),
    }));

    const summaries = createQueries(() => ({
        queries: scopes.map(({ cluster, serviceIds }) =>
            orpc.cluster.getHttpSummary.queryOptions({
                input: {
                    clusterId: cluster.id,
                    range: range.value,
                    serviceIds,
                },
                ...options,
            }),
        ),
    }));

    function chartQuery(scopeIndex: number, name: HttpMetricName) {
        return charts[
            scopeIndex * httpTrafficMetricNames.length +
                httpTrafficMetricNames.findIndex(
                    (item) => item === name,
                )
        ];
    }

    const multiCluster = $derived(scopes.length > 1);

    function serviceChart(name: HttpMetricName): ChartSeries[] {
        return scopes.flatMap(({ cluster }, index) =>
            (chartQuery(index, name)?.data?.series ?? []).map(
                (series) => ({
                    key: `${cluster.id}:${name}:${series.serviceId}`,
                    machineKey: `${cluster.id}:${series.serviceId}`,
                    label: multiCluster
                        ? `${cluster.name} / ${serviceName(series.serviceId)}`
                        : serviceName(series.serviceId),
                    color: serviceColor(series.serviceId),
                    points: series.points,
                }),
            ),
        );
    }

    const statusColors = new Map([
        ["1xx", "var(--muted-foreground)"],
        ["2xx", "var(--success)"],
        ["3xx", "var(--info)"],
        ["4xx", "var(--warning)"],
        ["5xx", "var(--destructive)"],
    ]);

    const statusChart = $derived(
        scopes.flatMap(({ cluster }, index) =>
            (chartQuery(index, "httpStatus")?.data?.series ?? [])
                .toSorted((a, b) =>
                    (a.statusClass ?? "").localeCompare(
                        b.statusClass ?? "",
                    ),
                )
                .map((series) => {
                    const status = series.statusClass ?? "other";

                    return {
                        key: `${cluster.id}:status:${status}`,
                        label: multiCluster
                            ? `${cluster.name} / ${status}`
                            : status,
                        color:
                            statusColors.get(status) ??
                            "var(--muted-foreground)",
                        points: series.points,
                    };
                }),
        ),
    );

    const loadedCharts = $derived(
        charts.flatMap((item) => (item.data ? [item.data] : [])),
    );

    const start = $derived(
        Math.min(...loadedCharts.map((item) => item.start), Infinity),
    );

    const end = $derived(
        Math.max(...loadedCharts.map((item) => item.end), 0),
    );

    const statuses = $derived(
        scopes.map(({ cluster }, index) => ({
            cluster,
            status: summaries[index]?.data?.status,
            error:
                summaries[index]?.error ??
                chartQuery(index, "httpRequests")?.error,
        })),
    );

    const charting = $derived(
        statuses.some((item) => item.status === "ok"),
    );

    const fetching = $derived(
        [...charts, ...summaries].some((item) => item.isFetching),
    );

    // Show the skeleton only for the initial request; refetches keep everything mounted.
    const pending = $derived(
        list.isPending ||
            inventories.some((item) => item.isPending) ||
            (!summaries.some((item) => item.data) &&
                summaries.some((item) => item.isPending)),
    );

    const rows = $derived(
        scopes
            .flatMap(({ cluster }, index) =>
                (summaries[index]?.data?.services ?? []).map(
                    (service) => ({
                        ...service,
                        key: `${cluster.id}:${service.serviceId}`,
                        cluster,
                        name: serviceName(service.serviceId),
                        href:
                            serviceInfo.get(service.serviceId)
                                ?.href ?? null,
                        color: serviceColor(service.serviceId),
                    }),
                ),
            )
            .toSorted(
                (a, b) =>
                    b.requests - a.requests ||
                    a.name.localeCompare(b.name),
            ),
    );

    const totals = $derived({
        requests: rows.reduce((sum, row) => sum + row.requests, 0),
        errors: rows.reduce((sum, row) => sum + row.errors, 0),
        bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
        // P95s cannot be combined across clusters; the slowest one is the honest figure.
        latency: summaries.reduce<number | null>(
            (slowest, item) =>
                item.data?.latency == null
                    ? slowest
                    : Math.max(slowest ?? 0, item.data.latency),
            null,
        ),
    });

    const visitors = $derived(
        summaries.flatMap((item) =>
            item.data?.visitors ? [item.data.visitors] : [],
        ),
    );

    // Clusters configured before visitor counting have no visitor table until re-initialized.
    const recordingVisitors = $derived(visitors.length > 0);

    const regions = new Intl.DisplayNames(undefined, {
        type: "region",
    });

    function countryName(code: string) {
        if (!code) return "Unknown location";

        try {
            return regions.of(code) ?? code;
        } catch {
            return code;
        }
    }

    const clientNames = new Map([
        ["desktop", "Desktop browsers"],
        ["mobile", "Mobile browsers"],
        ["bot", "Bots and scripts"],
    ]);

    /** Sums every cluster's breakdown and folds the long tail into one row. */
    function merge(
        pick: (item: (typeof visitors)[number]) => Breakdown[],
        label: (key: string) => string,
        limit = Infinity,
    ) {
        const sums = new Map<string, number>();

        for (const item of visitors)
            for (const { key, requests } of pick(item))
                sums.set(key, (sums.get(key) ?? 0) + requests);

        const sorted = [...sums]
            .toSorted((a, b) => b[1] - a[1])
            .map(([key, requests]) => ({
                key,
                label: label(key),
                requests: Math.round(requests),
            }));

        const rest = sorted.slice(limit);

        return rest.length
            ? [
                  ...sorted.slice(0, limit),
                  {
                      key: "other",
                      label: `${rest.length} more`,
                      requests: rest.reduce(
                          (sum, row) => sum + row.requests,
                          0,
                      ),
                  },
              ]
            : sorted;
    }

    const countries = $derived(
        merge((item) => item.countries, countryName, 8),
    );

    const clients = $derived(
        merge(
            (item) => item.clients,
            (key) => clientNames.get(key) ?? "Other clients",
        ),
    );

    const protocols = $derived(
        merge(
            (item) => item.protocols,
            (key) =>
                key.replace(/^HTTP\/([23])\.0$/u, "HTTP/$1") ||
                "Unknown",
        ),
    );

    let hovered = $state("");

    const chartGrid = $derived([
        {
            title: "Requests per second",
            series: serviceChart("httpRequests"),
            unit: "requests" as const,
            legend: false,
        },
        {
            title: "Responses by status",
            series: statusChart,
            unit: "requests" as const,
            // Service charts share the services table's colors; status classes need their own key.
            legend: true,
        },
        {
            title: "P95 latency",
            series: serviceChart("httpLatency"),
            unit: "duration" as const,
            legend: false,
        },
        {
            title: "Data served",
            series: serviceChart("httpBandwidth"),
            unit: "rate" as const,
            legend: false,
        },
    ]);

    const filteredOut = $derived(
        filters.services.current.length > 0 && !scopes.length,
    );

    function toggle(ids: string[], id: string) {
        return ids.includes(id)
            ? ids.filter((item) => item !== id)
            : [...ids, id];
    }

    function toggleCluster(id: string) {
        void filters.set({
            clusters: toggle(selected, id),
            services: [],
        });
    }

    function toggleService(id: string) {
        void filters.set({
            services: toggle(filters.services.current, id),
        });
    }

    const routedServices = $derived(
        monitoredSelection.flatMap((cluster, index) =>
            (inventories[index]?.data ?? []).map((service) => ({
                ...service,
                cluster,
            })),
        ),
    );

    useHeaderActions(toolbar);
</script>

<svelte:head>
    <title>HTTP traffic · Observability · Stoat</title>
</svelte:head>

{#snippet toolbar()}
    <div
        class="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"
    >
        <Popover>
            <PopoverTrigger
                class={buttonVariants({
                    variant: "outline",
                    size: "sm",
                })}
                disabled={list.isPending}
            >
                Clusters: {selection.length === 1
                    ? selection[0].name
                    : `${selection.length} selected`}<ChevronDown
                    class="ml-2 size-4"
                />
            </PopoverTrigger>
            <PopoverContent align="start" class="w-72 p-3">
                <p
                    class="px-2 py-1 text-xs font-medium text-muted-foreground"
                >
                    Select clusters
                </p>
                {#each clusters as cluster (cluster.id)}
                    <label
                        class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                    >
                        <Checkbox
                            checked={selected.includes(cluster.id)}
                            onCheckedChange={() =>
                                toggleCluster(cluster.id)}
                        />
                        <span class="truncate">{cluster.name}</span>
                    </label>
                {/each}
            </PopoverContent>
        </Popover>
        {#if routedServices.length}
            <Popover>
                <PopoverTrigger
                    class={buttonVariants({
                        variant: "outline",
                        size: "sm",
                    })}
                >
                    Services: {filters.services.current.length
                        ? `${filters.services.current.length} selected`
                        : "All"}<ChevronDown class="ml-2 size-4" />
                </PopoverTrigger>
                <PopoverContent align="start" class="w-72 p-3">
                    <div
                        class="flex items-center justify-between px-2 py-1"
                    >
                        <p
                            class="text-xs font-medium text-muted-foreground"
                        >
                            Filter services
                        </p>
                        {#if filters.services.current.length}
                            <Button
                                variant="ghost"
                                size="xs"
                                onclick={() =>
                                    void filters.set({
                                        services: [],
                                    })}
                            >
                                Show all
                            </Button>
                        {/if}
                    </div>
                    <div class="max-h-80 overflow-y-auto">
                        {#each routedServices as service (service.id)}
                            <label
                                class="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                            >
                                <Checkbox
                                    checked={filters.services.current.includes(
                                        service.id,
                                    )}
                                    onCheckedChange={() =>
                                        toggleService(service.id)}
                                />
                                <span class="truncate">
                                    {monitoredSelection.length > 1
                                        ? `${service.cluster.name} / ${service.name}`
                                        : service.name}
                                </span>
                            </label>
                        {/each}
                    </div>
                </PopoverContent>
            </Popover>
        {/if}
        {#if monitoredSelection.length}
            <RangeControls
                {range}
                bind:paused={filters.paused.current}
                {fetching}
                onrefresh={() =>
                    [...charts, ...summaries].forEach(
                        (item) => void item.refetch(),
                    )}
            />
        {/if}
    </div>
{/snippet}

{#snippet stat(label: string, value: string, detail: string)}
    <div class="min-w-0 space-y-1 px-5 py-4">
        <p class="text-xs text-muted-foreground">{label}</p>
        <p class="truncate text-2xl font-semibold tabular-nums">
            {value}
        </p>
        <p class="truncate text-xs text-muted-foreground">{detail}</p>
    </div>
{/snippet}

{#snippet visitorsUnavailable()}
    <p class="text-sm text-muted-foreground">
        Re-initialize monitoring on this cluster to record where
        requests come from.
    </p>
{/snippet}

<div class="min-w-0 w-full space-y-4 py-4 sm:space-y-6 sm:py-6">
    {#if list.isError}
        <Alert variant="error">
            <AlertDescription>
                Could not load clusters. <button
                    class="underline"
                    onclick={() => list.refetch()}
                >
                    Try again
                </button>
            </AlertDescription>
        </Alert>
    {/if}
    {#each unmonitoredSelection as cluster (cluster.id)}
        <Alert variant="warning">
            <AlertDescription>
                <span class="font-medium">{cluster.name}:</span>
                Initialize monitoring to record ingress traffic.
                <a
                    class="underline underline-offset-2"
                    href={`/clusters/${cluster.id}`}
                >
                    Open cluster
                </a>
            </AlertDescription>
        </Alert>
    {/each}
    {#each statuses as { cluster, status, error } (cluster.id)}
        {#if error}
            <Alert variant="warning">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    {error.message}
                    <a
                        class="underline underline-offset-2"
                        href={`/clusters/${cluster.id}`}
                    >
                        Open cluster
                    </a>
                </AlertDescription>
            </Alert>
        {:else if status === "no-routes"}
            <Alert variant="info">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    No services have an HTTP or HTTPS ingress hostname yet.
                    Add a domain to a service to record its traffic.
                </AlertDescription>
            </Alert>
        {:else if status === "not-collecting"}
            <Alert variant="info">
                <AlertDescription>
                    <span class="font-medium">{cluster.name}:</span>
                    No HTTP traffic recorded yet. Request metrics appear
                    after the first proxied request; clusters initialized
                    before Caddy metrics were added need monitoring re-initialized.
                </AlertDescription>
            </Alert>
        {/if}
    {/each}
    {#if pending}
        <Skeleton loading loading-label="Loading HTTP traffic">
            <div class="space-y-4 sm:space-y-6">
                <div class="h-28 rounded-2xl">Loading summary</div>
                <div class="grid gap-4 lg:grid-cols-2">
                    {#each chartGrid as item (item.title)}<div
                            class="h-64 rounded-2xl"
                        >
                            Loading {item.title}
                        </div>{/each}
                </div>
                <div class="h-72 rounded-2xl">Loading services</div>
            </div>
        </Skeleton>
    {:else if !selection.length}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>
                    {clusters.length
                        ? "Select a cluster"
                        : "No clusters yet"}
                </EmptyTitle><EmptyDescription>
                    {clusters.length
                        ? "Choose a cluster to inspect ingress traffic."
                        : "Create a cluster and initialize monitoring to record ingress traffic."}
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else if filteredOut}
        <Empty>
            <EmptyHeader>
                <EmptyTitle>No matching services</EmptyTitle>
                <EmptyDescription>
                    None of the filtered services run on the selected
                    clusters.
                </EmptyDescription>
            </EmptyHeader>
            <Button
                variant="outline"
                size="sm"
                onclick={() => void filters.set({ services: [] })}
            >
                Show all services
            </Button>
        </Empty>
    {:else if charting}
        <Frame>
            <FramePanel class="grid grid-cols-2 p-0 lg:grid-cols-4">
                {@render stat(
                    "Requests",
                    count(totals.requests),
                    `${rows.filter((row) => row.requests > 0).length} of ${rows.length} services with traffic`,
                )}
                {@render stat(
                    "Server errors",
                    totals.requests
                        ? percent(
                              (100 * totals.errors) / totals.requests,
                          )
                        : "—",
                    `${count(totals.errors)} 5xx responses`,
                )}
                {@render stat(
                    "P95 latency",
                    duration(totals.latency),
                    multiCluster
                        ? "Slowest selected cluster"
                        : "Across all requests",
                )}
                {@render stat(
                    "Data served",
                    bytes(totals.bytes),
                    "Response bodies",
                )}
            </FramePanel>
        </Frame>

        <div class="grid gap-4 lg:grid-cols-2">
            {#each chartGrid as item (item.title)}<Frame
                    class="min-w-0"
                >
                    <FrameHeader>
                        <FrameTitle>{item.title}</FrameTitle>
                    </FrameHeader><FramePanel class="min-w-0 p-4">
                        {#if item.legend}
                            <!-- Status lines belong to no service, so hovering a service must not dim them. -->
                            <MetricChart
                                series={item.series}
                                {start}
                                {end}
                                unit={item.unit}
                            />
                        {:else}
                            <MetricChart
                                series={item.series}
                                {start}
                                {end}
                                unit={item.unit}
                                bind:hoveredMachine={hovered}
                            />
                        {/if}
                        {#if item.legend}
                            <div
                                class="mt-3 flex flex-wrap gap-x-4 gap-y-2"
                            >
                                {#each item.series as series (series.key)}
                                    <span
                                        class="flex items-center gap-2 text-xs"
                                    >
                                        <span
                                            class="size-2 rounded-full"
                                            style:background={series.color}
                                            aria-hidden="true"
                                        ></span>
                                        {series.label}
                                    </span>
                                {/each}
                            </div>
                        {/if}
                    </FramePanel>
                </Frame>{/each}
        </div>

        <Frame class="min-w-0">
            <FrameHeader>
                <FrameTitle>Services</FrameTitle>
                <FrameDescription>
                    Totals for the selected range. Select a service to
                    filter the page.
                </FrameDescription>
            </FrameHeader>
            <FramePanel class="min-w-0 overflow-x-auto p-0">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Service</TableHead>
                            <TableHead class="text-right">
                                Requests
                            </TableHead>
                            <TableHead class="text-right">
                                5xx
                            </TableHead>
                            <TableHead class="text-right">
                                P95
                            </TableHead>
                            <TableHead class="text-right">
                                Data served
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {#each rows as row (row.key)}
                            {@const active =
                                filters.services.current.includes(
                                    row.serviceId,
                                )}
                            <TableRow
                                data-state={active
                                    ? "selected"
                                    : undefined}
                                style={`opacity: ${hovered && hovered !== row.key ? 0.5 : 1}`}
                                onpointerenter={() =>
                                    (hovered = row.key)}
                                onpointerleave={() => (hovered = "")}
                            >
                                <TableCell class="max-w-80">
                                    <button
                                        type="button"
                                        class="flex min-w-0 items-center gap-2 text-left"
                                        aria-pressed={active}
                                        title={active
                                            ? "Remove from the filter"
                                            : "Filter the page to this service"}
                                        onclick={() =>
                                            toggleService(
                                                row.serviceId,
                                            )}
                                    >
                                        <span
                                            class="size-2 shrink-0 rounded-full"
                                            style:background={row.color}
                                            aria-hidden="true"
                                        ></span>
                                        <span class="min-w-0">
                                            <span
                                                class="block truncate font-medium"
                                            >
                                                {multiCluster
                                                    ? `${row.cluster.name} / ${row.name}`
                                                    : row.name}
                                            </span>
                                            <span
                                                class="block truncate text-xs text-muted-foreground"
                                            >
                                                {row.hosts.join(", ")}
                                            </span>
                                        </span>
                                    </button>
                                </TableCell>
                                <TableCell
                                    class="text-right tabular-nums"
                                >
                                    {count(row.requests)}
                                </TableCell>
                                <TableCell
                                    class="text-right tabular-nums {row.errors
                                        ? 'text-destructive-foreground'
                                        : 'text-muted-foreground'}"
                                >
                                    {row.requests
                                        ? percent(
                                              (100 * row.errors) /
                                                  row.requests,
                                          )
                                        : "—"}
                                </TableCell>
                                <TableCell
                                    class="text-right tabular-nums"
                                >
                                    {duration(row.latency)}
                                </TableCell>
                                <TableCell
                                    class="text-right tabular-nums"
                                >
                                    {bytes(row.bytes)}
                                </TableCell>
                            </TableRow>
                        {/each}
                    </TableBody>
                </Table>
            </FramePanel>
        </Frame>

        <div class="grid gap-4 lg:grid-cols-2">
            <Frame class="min-w-0">
                <FrameHeader>
                    <FrameTitle>Countries</FrameTitle>
                    <FrameDescription>
                        Where requests came from, by client IP.
                    </FrameDescription>
                </FrameHeader>
                <FramePanel class="min-w-0">
                    {#if !recordingVisitors}
                        {@render visitorsUnavailable()}
                    {:else if countries.length}
                        <HttpBreakdown
                            label="Requests by country"
                            rows={countries}
                        />
                    {:else}
                        <p class="text-sm text-muted-foreground">
                            No requests in this range.
                        </p>
                    {/if}
                </FramePanel>
                <p class="px-5 py-3 text-xs text-muted-foreground">
                    IP geolocation by <a
                        class="underline underline-offset-2"
                        href="https://db-ip.com"
                        target="_blank"
                        rel="noreferrer"
                    >
                        DB-IP
                    </a>
                    .
                </p>
            </Frame>
            <Frame class="min-w-0">
                <FrameHeader>
                    <FrameTitle>Clients</FrameTitle>
                    <FrameDescription>
                        What sent the requests, from the User-Agent
                        header.
                    </FrameDescription>
                </FrameHeader>
                <FramePanel class="min-w-0 space-y-6">
                    {#if !recordingVisitors}
                        {@render visitorsUnavailable()}
                    {:else if clients.length}
                        <HttpBreakdown
                            label="Requests by client type"
                            rows={clients}
                        />
                        <div class="space-y-3">
                            <p
                                class="text-xs font-medium text-muted-foreground"
                            >
                                HTTP version
                            </p>
                            <HttpBreakdown
                                label="Requests by HTTP version"
                                rows={protocols}
                            />
                        </div>
                    {:else}
                        <p class="text-sm text-muted-foreground">
                            No requests in this range.
                        </p>
                    {/if}
                </FramePanel>
            </Frame>
        </div>
    {/if}
</div>
