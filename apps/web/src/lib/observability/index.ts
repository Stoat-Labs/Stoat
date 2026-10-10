import { ORPCError } from "@orpc/client";
import {
    metricNames,
    type ClusterObservability,
    type MetricName,
    type MachineMetricName,
    type MetricPoint,
    type MetricSeries,
    type ObservabilityContainer,
    type ObservabilityService,
} from "@stoat/api/observability";

export type ClusterData = ClusterObservability & {
    id: string;
    name: string;
    totals?: Partial<Record<MachineMetricName, MetricSeries[]>>;
};

export type Loaded<T> = { data: T | undefined; error: Error | null; isPending: boolean };

export type MetricResult = {
    start: number;
    end: number;
    step: number;
    series: MetricSeries[];
    totals?: MetricSeries[];
};

/** Merge the per-procedure queries of one cluster into the shape the charts consume, so each chart fills in as its metric arrives. */
export function assembleCluster(
    cluster: { id: string; name: string },
    machines: Loaded<ClusterObservability["machines"]>,
    services: Loaded<ObservabilityService[]>,
    metrics: Loaded<MetricResult>[],
    names: readonly MachineMetricName[] = metricNames,
): ClusterData {
    const loaded = metrics.flatMap((query) => (query.data ? [query.data] : []));

    const uninitialized = [machines, services, ...metrics].some(
        ({ error }) => error instanceof ORPCError && error.code === "PRECONDITION_FAILED",
    );

    const result: ClusterData = {
        ...cluster,
        available: loaded.length > 0,
        start: Math.min(...loaded.map((window) => window.start), Infinity),
        end: Math.max(...loaded.map((window) => window.end), 0),
        step: loaded.length ? Math.min(...loaded.map((window) => window.step)) : 15,
        machines: machines.data ?? [],
        services: services.data ?? [],
        metrics: {},
        totals: {},
        unavailable: [
            ...(machines.error ? ["Machine inventory"] : []),
            ...(services.error ? ["Service inventory"] : []),
        ],
    };

    names.forEach((name, index) => {
        const query = metrics[index];

        if (query?.data) {
            result.metrics[name] = query.data.series;
            result.totals![name] = query.data.totals;
        } else if (query?.error) result.unavailable.push(name);
    });

    if (uninitialized) result.reason = "uninitialized";
    else if (!result.available && metrics.every((query) => !query.isPending))
        result.reason = "unreachable";

    return result;
}

export type MachineData = {
    key: string;
    id: string;
    name: string;
    cluster: ClusterData;
    color: string;
};

export type ChartSeries = {
    key: string;
    machineKey?: string;
    label: string;
    color: string;
    dashed?: boolean;
    points: MetricPoint[];
};

type Usage = {
    cpu: number | null;
    /** Cores; null when any container is unlimited. */
    cpuLimit: number | null;
    memory: number | null;
    /** Bytes; null when any container is unlimited. */
    memoryLimit: number | null;
    /** Of the memory limit, or of machine memory when unlimited. */
    memoryPercent: number | null;
    networkIn: number | null;
    networkOut: number | null;
    restarts: number;
    oomKilled: number;
};

export type ContainerRow = Omit<ObservabilityContainer, "oomKilled"> & Usage & { key: string };

export type ServiceRow = Omit<ObservabilityService, "containers"> &
    Usage & {
        key: string;
        color: string;
        clusterId: string;
        clusterName: string;
        /** Machine ID when the rows are filtered to one machine, otherwise "". */
        scope: string;
        containers: ContainerRow[];
        running: number;
        unhealthy: number;
        machines: string[];
    };

export function percent(value: number | null | undefined) {
    return value == null
        ? "—"
        : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

export function bytes(value: number | null | undefined) {
    if (value == null) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];

    const index = Math.min(
        4,
        Math.max(0, Math.floor(Math.log2(Math.max(1, Math.abs(value))) / 10)),
    );

    return `${(Math.abs(value) / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
}

/**
 * Axis ticks for byte values that land on round binary units (1 KiB, 2 KiB, ...) instead of
 * decimal ones (1,000 B, 2,000 B), which format as uneven KiB labels.
 */
export function byteTicks(max: number, count: number) {
    let unit = 1024 ** Math.min(4, Math.max(0, Math.floor(Math.log2(max) / 10)));

    const stepIn = (size: number) => {
        const rough = max / size / count;
        const magnitude = 10 ** Math.floor(Math.log10(rough));

        return ([1, 2, 5].find((factor) => factor * magnitude >= rough) ?? 10) * magnitude * size;
    };

    let step = stepIn(unit);

    // 800 B would round up to a "1,000 B" top tick, so count in the next unit instead.
    if (Math.ceil(max / step) * step >= 1000 * unit && unit < 1024 ** 4) {
        unit *= 1024;
        step = stepIn(unit);
    }

    return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}

export function bandwidth(value: number | null | undefined) {
    return value == null ? "—" : `${bytes(value)}/s`;
}

export function requests(value: number | null | undefined) {
    return value == null
        ? "—"
        : `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 })} req/s`;
}

export function count(value: number | null | undefined) {
    return value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function perSecond(value: number | null | undefined) {
    return value == null
        ? "—"
        : `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 0 })}/s`;
}

export type MetricUnit =
    | "percent"
    | "bytes"
    | "rate"
    | "requests"
    | "duration"
    | "count"
    | "perSecond";

export function duration(seconds: number | null | undefined) {
    if (seconds == null) return "—";

    return seconds < 1
        ? `${(seconds * 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`
        : `${seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

/** Point-wise sum; a timestamp is a gap only when no series has a sample there. */
export function sumPoints(series: (MetricPoint[] | undefined)[]): MetricPoint[] {
    const totals = new Map<number, number | null>();

    for (const points of series)
        for (const point of points ?? [])
            totals.set(
                point.time,
                point.value === null
                    ? (totals.get(point.time) ?? null)
                    : (totals.get(point.time) ?? 0) + point.value,
            );

    return [...totals].sort(([a], [b]) => a - b).map(([time, value]) => ({ time, value }));
}

/**
 * Linearly bridge short interior runs of missing samples so sparse series (p95 latency,
 * error rate on bursty traffic) still draw a line through the samples that exist. Leading
 * and trailing gaps stay gaps, and longer outages are preserved instead of papered over.
 */
export function bridgeGaps(points: MetricPoint[], maxGapMs = 5 * 60 * 1000): MetricPoint[] {
    const filled = points.map((point) => ({ ...point }));
    let anchor = -1;

    for (let index = 0; index < filled.length; index++) {
        const point = filled[index];

        if (!point || point.value === null) continue;

        const previous = anchor >= 0 ? filled[anchor] : undefined;

        if (previous && previous.value !== null) {
            const span = point.time - previous.time;

            if (index - anchor > 1 && span > 0 && span <= maxGapMs) {
                const from = previous.value;

                for (let gap = anchor + 1; gap < index; gap++) {
                    const missing = filled[gap];

                    if (missing)
                        missing.value =
                            from + ((point.value - from) * (missing.time - previous.time)) / span;
                }
            }
        }

        anchor = index;
    }

    return filled;
}

/** Combined points of every series matching the machine, service and container ("" for host metrics; undefined matches any). */
export function metricTotals(
    cluster: ClusterObservability,
    name: MachineMetricName,
    machineId?: string,
) {
    return sumPoints(
        (cluster.totals?.[name] ?? []).flatMap((series) =>
            machineId === undefined || series.machineId === machineId ? [series.points] : [],
        ),
    );
}

export function metric(
    cluster: ClusterObservability,
    name: MachineMetricName,
    machineId?: string,
    serviceId = "",
    container?: string,
) {
    return sumPoints(
        (cluster.metrics[name] ?? []).flatMap((series) =>
            (machineId === undefined || series.machineId === machineId) &&
            series.serviceId === serviceId &&
            (container === undefined || series.container === container)
                ? [series.points]
                : [],
        ),
    );
}

export function current(points: MetricPoint[] | undefined, end: number, step: number) {
    const last = points?.at(-1);

    return last && end * 1000 - last.time < step * 1000 ? last.value : null;
}

export function machineValue(machine: MachineData, name: MetricName) {
    return current(
        metric(machine.cluster, name, machine.id),
        machine.cluster.end,
        machine.cluster.step,
    );
}

export function machineList(clusters: ClusterData[]): MachineData[] {
    const machines = clusters.flatMap((cluster) => {
        const names = new Map(cluster.machines.map((machine) => [machine.id, machine.name]));

        for (const series of Object.values(cluster.metrics))
            for (const item of series ?? [])
                if (!names.has(item.machineId)) names.set(item.machineId, item.machineId);

        return [...names].map(([id, name]) => ({
            key: `${cluster.id}:${id}`,
            id,
            name,
            cluster,
        }));
    });

    const colors = nameColors(machines.map((machine) => machine.name));

    return machines.map((machine) => ({
        ...machine,
        color: colors.get(machine.name) ?? seriesColor(machine.name),
    }));
}

/** Distinct colors for a set of names: hues are spread by sorted position (golden angle), so input order doesn't matter. */
export function nameColors(names: string[]) {
    return new Map(
        [...new Set(names)].sort().map((name, index) => [name, hueColor(index * 137.5 + 265)]),
    );
}

function hueColor(hue: number) {
    return `oklch(var(--series-lightness) var(--series-chroma) ${hue % 360})`;
}

/** A color derived only from `name`, so a machine or service looks the same in every chart. */
export function seriesColor(name: string) {
    // FNV-1a spreads similar names (stoat-monitoring-*) across the hue wheel.
    let hash = 2166136261;

    for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);

    return hueColor(hash >>> 0);
}

export function chartSeries(machines: MachineData[], name: MachineMetricName): ChartSeries[] {
    return machines.map((machine) => ({
        key: `${machine.key}:${name}`,
        machineKey: machine.key,
        label: `${machine.cluster.name} / ${machine.name}`,
        color: machine.color,
        dashed: name === "networkOut" || name === "diskWrite",
        points: metric(machine.cluster, name, machine.id),
    }));
}

export function chartSeriesRatio(
    machines: MachineData[],
    numerator: MachineMetricName,
    denominator: MachineMetricName,
): ChartSeries[] {
    return machines.map((machine) => {
        const total = new Map(
            metric(machine.cluster, denominator, machine.id).map((point) => [
                point.time,
                point.value,
            ]),
        );

        return {
            key: `${machine.key}:${numerator}/${denominator}`,
            machineKey: machine.key,
            label: `${machine.cluster.name} / ${machine.name}`,
            color: machine.color,
            points: metric(machine.cluster, numerator, machine.id).map((point) => {
                const value = total.get(point.time);

                return {
                    time: point.time,
                    value: point.value !== null && value ? (100 * point.value) / value : null,
                };
            }),
        };
    });
}

/** Keep mount identities for charts and match capacity to the same filesystem, never another disk. */
export function filesystemRows(machines: MachineData[]) {
    return machines
        .flatMap((machine) =>
            (machine.cluster.metrics.filesystemTotal ?? []).flatMap((capacity) => {
                if (capacity.machineId !== machine.id || !capacity.mountpoint) return [];

                const used = machine.cluster.metrics.filesystemUsed?.find(
                    (series) =>
                        series.machineId === machine.id &&
                        series.device === capacity.device &&
                        series.mountpoint === capacity.mountpoint &&
                        series.fstype === capacity.fstype,
                );

                const totals = new Map(capacity.points.map((point) => [point.time, point.value]));

                const points = (
                    used?.points ?? capacity.points.map((point) => ({ ...point, value: null }))
                ).map((point) => {
                    const total = totals.get(point.time);

                    return {
                        time: point.time,
                        value: point.value !== null && total ? (100 * point.value) / total : null,
                    };
                });

                const at = (samples: MetricPoint[] | undefined) =>
                    current(samples, machine.cluster.end, machine.cluster.step);

                return [
                    {
                        // LayerChart treats brackets and dots in keys as nested property paths.
                        key: encodeURIComponent(
                            JSON.stringify([
                                machine.key,
                                capacity.device,
                                capacity.mountpoint,
                                capacity.fstype,
                            ]),
                        ).replaceAll(".", "%2E"),
                        machineKey: machine.key,
                        label: `${machine.cluster.name} / ${machine.name} · ${capacity.mountpoint}`,
                        color: seriesColor(`${machine.name} ${capacity.mountpoint}`),
                        device: capacity.device ?? "",
                        mountpoint: capacity.mountpoint,
                        fstype: capacity.fstype ?? "",
                        used: at(used?.points),
                        total: at(capacity.points),
                        percent: at(points),
                        points,
                    },
                ];
            }),
        )
        .sort((a, b) => a.label.localeCompare(b.label) || a.device.localeCompare(b.device));
}

/** The busiest `limit` services by `rank`, so charts stay readable. */
export function topServices(
    rows: ServiceRow[],
    rank: (row: ServiceRow) => number | null,
    limit = 16,
) {
    return [...rows].sort((a, b) => (rank(b) ?? -1) - (rank(a) ?? -1)).slice(0, limit);
}

export const rankCpu = (row: ServiceRow) => row.cpu;

export const rankMemory = (row: ServiceRow) => row.memory;

export const rankTraffic = (row: ServiceRow) =>
    row.networkIn === null && row.networkOut === null
        ? null
        : (row.networkIn ?? 0) + (row.networkOut ?? 0);

/** One line per service (all its containers combined) for the top services by `rank`. */
export function serviceSeries(
    clusters: ClusterData[],
    rows: ServiceRow[],
    names: MetricName[],
    rank: (row: ServiceRow) => number | null,
    limit = 16,
): ChartSeries[] {
    const top = topServices(rows, rank, limit);

    return names.flatMap((name) =>
        top.flatMap((row) => {
            const cluster = clusters.find((item) => item.id === row.clusterId);

            return cluster
                ? [
                      {
                          key: `${row.key}:${name}`,
                          machineKey: row.key,
                          label: row.name,
                          color: row.color,
                          // Send is only dashed when it shares a chart with receive.
                          dashed: name === "serviceNetworkOut" && names.length > 1,
                          points: metric(cluster, name, row.scope || undefined, row.id),
                      },
                  ]
                : [];
        }),
    );
}

export function sumMachines(machines: MachineData[], name: MetricName) {
    const values = machines.map((machine) => machineValue(machine, name));

    return values.length && values.every((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null;
}

function total(values: (number | null)[]) {
    return values.length && values.some((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null;
}

function limit(values: (number | null)[]) {
    return values.length && values.every((value) => value !== null) ? total(values) : null;
}

/**
 * One row per service with its containers nested. Metrics are matched to containers by machine and
 * Docker name; `machineKey` (cluster:machine) keeps only containers on that machine.
 */
export function serviceRows(clusters: ClusterData[], machineKey = ""): ServiceRow[] {
    const colors = nameColors(
        clusters.flatMap((cluster) => cluster.services.map((item) => item.name)),
    );

    return clusters.flatMap((cluster) =>
        cluster.services.flatMap((service) => {
            const at = (points: MetricPoint[]) => current(points, cluster.end, cluster.step);

            const scope = machineKey.startsWith(`${cluster.id}:`)
                ? machineKey.slice(cluster.id.length + 1)
                : "";

            if (machineKey && !scope) return [];

            const containers = service.containers.flatMap((item): ContainerRow[] => {
                if (scope && item.machineId !== scope) return [];

                const value = (name: MetricName) =>
                    at(metric(cluster, name, item.machineId, service.id, item.name));

                const memory = value("serviceMemory");

                const capacity =
                    item.memoryLimit ?? at(metric(cluster, "memoryTotal", item.machineId));

                return [
                    {
                        ...item,
                        key: `${cluster.id}:${service.id}:${item.machineId}:${item.id || item.name}`,
                        cpu: value("serviceCpu"),
                        memory,
                        memoryPercent:
                            memory !== null && capacity ? (100 * memory) / capacity : null,
                        networkIn: value("serviceNetworkIn"),
                        networkOut: value("serviceNetworkOut"),
                        oomKilled: item.oomKilled ? 1 : 0,
                    },
                ];
            });

            if (scope && !containers.length) return [];

            // Totals come from every series of the service, so they hold even if container names don't match.
            const value = (name: MetricName) =>
                at(metric(cluster, name, scope || undefined, service.id));

            const memory = value("serviceMemory");
            const memoryLimit = limit(containers.map((item) => item.memoryLimit));

            return [
                {
                    id: service.id,
                    name: service.name,
                    href: service.href,
                    key: `${cluster.id}:${service.id}`,
                    color: colors.get(service.name) ?? seriesColor(service.name),
                    clusterId: cluster.id,
                    clusterName: cluster.name,
                    scope,
                    containers,
                    running: containers.filter((item) => item.running).length,
                    unhealthy: containers.filter((item) => item.health === "unhealthy").length,
                    machines: [...new Set(containers.map((item) => item.machineName))],
                    cpu: value("serviceCpu"),
                    cpuLimit: limit(containers.map((item) => item.cpuLimit)),
                    memory,
                    memoryLimit,
                    memoryPercent:
                        memory !== null && memoryLimit ? (100 * memory) / memoryLimit : null,
                    networkIn: value("serviceNetworkIn"),
                    networkOut: value("serviceNetworkOut"),
                    restarts: containers.reduce((sum, item) => sum + item.restarts, 0),
                    oomKilled: containers.reduce((sum, item) => sum + item.oomKilled, 0),
                },
            ];
        }),
    );
}
