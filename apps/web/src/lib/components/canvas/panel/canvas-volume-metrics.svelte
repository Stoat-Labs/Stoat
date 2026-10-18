<script lang="ts">
    import { browser } from "$app/environment";
    import { orpc } from "$lib/api/orpc";
    import { syncMetricCharts } from "$lib/components/observability/chart-sync";
    import MetricChart from "$lib/components/observability/metric-chart.svelte";
    import { useObservabilityRange } from "$lib/components/observability/range";
    import RangeControls from "$lib/components/observability/range-controls.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        bandwidth,
        bytes,
        seriesColor,
        sumPoints,
        unpackMetric,
        type ChartSeries,
    } from "$lib/observability";
    import { volumeMetricNames } from "@stoat/api/observability";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";

    let {
        projectId,
        resourceId,
        volume,
        mountedBy,
    }: {
        projectId: string;
        resourceId: string;
        /** Compose name of the volume. */
        volume: string;
        /** Compose service names that mount the volume. */
        mountedBy: string[];
    } = $props();

    const range = useObservabilityRange();

    syncMetricCharts();

    const paused = useQueryState(
        "paused",
        parseAsBoolean.withDefault(false),
    );

    const project = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: browser && projectId.length > 0,
        }),
    );

    const clusterId = $derived(project.data?.clusterId ?? "");

    const options = $derived({
        enabled: browser && clusterId.length > 0,
        refetchInterval:
            paused.current || range.custom
                ? (false as const)
                : 30_000,
        retry: false,
        staleTime: 25_000,
    });

    // The server matches the deployed names, so no service lookup comes first.
    const metrics = createQueries(() => ({
        queries: volumeMetricNames.map((name) =>
            orpc.cluster.getObservabilityMetric.queryOptions({
                input: {
                    clusterId,
                    name,
                    range: range.value,
                    volume: {
                        resourceId,
                        name: volume,
                        services: mountedBy,
                    },
                },
                select: unpackMetric,
                ...options,
            }),
        ),
    }));

    const [size, read, write] = $derived([
        metrics[0],
        metrics[1],
        metrics[2],
    ]);

    // Deployed services carry the resource's prefix (`<slug>-<service>`).
    const serviceOf = (deployed: string) =>
        mountedBy.find(
            (name) =>
                deployed === name || deployed.endsWith(`-${name}`),
        ) ?? deployed;

    const span = (...queries: (typeof size)[]) => {
        const loaded = queries.flatMap((query) =>
            query?.data ? [query.data] : [],
        );

        return {
            start: Math.min(
                ...loaded.map((item) => item.start),
                Infinity,
            ),
            end: Math.max(...loaded.map((item) => item.end), 0),
        };
    };

    const usage = $derived.by((): ChartSeries[] => {
        const points = sumPoints(
            (size?.data?.series ?? []).map((item) => item.points),
        );

        return points.length
            ? [
                  {
                      key: volume,
                      machineKey: volume,
                      label: volume,
                      color: seriesColor(volume),
                      points,
                  },
              ]
            : [];
    });

    // One chart for both directions, like Railway's: reads solid, writes dashed, a colour per service.
    const io = $derived.by(() => {
        const series = [read, write].flatMap((query, index) =>
            mountedBy.flatMap((service): ChartSeries[] => {
                const points = sumPoints(
                    (query?.data?.series ?? []).flatMap((item) =>
                        serviceOf(item.serviceId) === service
                            ? [item.points]
                            : [],
                    ),
                );

                return points.length
                    ? [
                          {
                              key: `${service}:${index}`,
                              machineKey: service,
                              label: `${service} ${index === 0 ? "read" : "write"}`,
                              color: seriesColor(service),
                              dashed: index === 1,
                              points,
                          },
                      ]
                    : [];
            }),
        );

        const latest = (suffix: string) =>
            bandwidth(
                series
                    .filter((item) => item.key.endsWith(suffix))
                    .reduce(
                        (sum, item) =>
                            sum + (item.points.at(-1)?.value ?? 0),
                        0,
                    ),
            );

        return {
            series,
            ...span(read, write),
            loading: Boolean(read?.isPending || write?.isPending),
            total: `Read ${latest(":0")} · Write ${latest(":1")}`,
        };
    });

    const fetching = $derived(
        metrics.some((query) => query.isFetching),
    );

    const failed = $derived(
        project.isError || metrics.some((query) => query.isError),
    );
</script>

<div class="min-w-0 space-y-4">
    <div class="flex justify-end">
        <RangeControls
            {range}
            bind:paused={paused.current}
            {fetching}
            disabled={!clusterId}
            onrefresh={() => {
                for (const query of metrics) void query.refetch();
            }}
        />
    </div>
    {#if failed}
        <Alert variant="error">
            <AlertDescription>
                Metrics aren't reachable right now.
            </AlertDescription>
        </Alert>
    {/if}
    <section class="min-w-0 rounded-lg border bg-card p-4">
        <header class="mb-3 flex items-center justify-between gap-2">
            <h4 class="font-medium">Size</h4>
            {#if usage.length}
                <span
                    class="text-xs text-muted-foreground tabular-nums"
                >
                    {bytes(usage[0]?.points.at(-1)?.value)}
                </span>
            {/if}
        </header>
        <MetricChart
            series={usage}
            {...span(size)}
            unit="bytes"
            loading={Boolean(size?.isPending)}
        />
    </section>
    <section class="min-w-0 rounded-lg border bg-card p-4">
        <header class="mb-3 flex items-center justify-between gap-2">
            <h4 class="font-medium">Disk I/O</h4>
            {#if io.series.length}
                <span
                    class="text-xs text-muted-foreground tabular-nums"
                >
                    {io.total}
                </span>
            {/if}
        </header>
        <MetricChart
            series={io.series}
            start={io.start}
            end={io.end}
            unit="rate"
            loading={io.loading}
        />
    </section>
</div>
