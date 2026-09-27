import { ORPCError } from "@orpc/client";
import {
    metricNames,
    type ClusterObservability,
    type MetricName,
    type MetricPoint,
    type MetricSeries,
    type ObservabilityService,
} from "@stoat/api/observability";

export type ClusterData = ClusterObservability & { id: string; name: string };

export type Loaded<T> = { data: T | undefined; error: Error | null; isPending: boolean };

export type MetricResult = { start: number; end: number; step: number; series: MetricSeries[] };

/** Merge the per-procedure queries of one cluster into the shape the charts consume, so each chart fills in as its metric arrives. */
export function assembleCluster(
    cluster: { id: string; name: string },
    machines: Loaded<ClusterObservability["machines"]>,
    services: Loaded<ObservabilityService[]>,
    metrics: Loaded<MetricResult>[],
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
        unavailable: [
            ...(machines.error ? ["Machine inventory"] : []),
            ...(services.error ? ["Service inventory"] : []),
        ],
    };

    metricNames.forEach((name, index) => {
        const query = metrics[index];

        if (query?.data) result.metrics[name] = query.data.series;
        else if (query?.error) result.unavailable.push(name);
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

export type ServiceRow = ObservabilityService & {
    key: string;
    clusterId: string;
    clusterName: string;
    cpu: number | null;
    memory: number | null;
    memoryPercent: number | null;
    networkIn: number | null;
    networkOut: number | null;
    trend: MetricPoint[];
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

export function bandwidth(value: number | null | undefined) {
    return value == null ? "—" : `${bytes(value)}/s`;
}

export function metric(
    cluster: ClusterObservability,
    name: MetricName,
    machineId: string,
    serviceId = "",
) {
    return cluster.metrics[name]?.find(
        (series) => series.machineId === machineId && series.serviceId === serviceId,
    );
}

export function current(series: MetricSeries | undefined, end: number, step: number) {
    const last = series?.points.at(-1);

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
    const colors = new Map<string, string>();

    return clusters.flatMap((cluster) => {
        const machines = new Map(cluster.machines.map((machine) => [machine.id, machine.name]));

        for (const series of Object.values(cluster.metrics))
            for (const item of series ?? [])
                if (!machines.has(item.machineId)) machines.set(item.machineId, item.machineId);

        return [...machines].map(([id, name]) => {
            const key = `${cluster.id}:${id}`;
            let hash = 0;

            for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
            let index = hash % 5;

            // Resolve palette collisions before repeating a color on dashboards with more than five machines.
            while (colors.size < 5 && colors.has(`var(--chart-${index + 1})`))
                index = (index + 1) % 5;
            const color = `var(--chart-${index + 1})`;
            colors.set(color, key);

            return { key, id, name, cluster, color };
        });
    });
}

export function chartSeries(machines: MachineData[], name: MetricName): ChartSeries[] {
    return machines.map((machine) => ({
        key: `${machine.key}:${name}`,
        machineKey: machine.key,
        label: `${machine.cluster.name} / ${machine.name}`,
        color: machine.color,
        dashed: name === "networkOut" || name === "diskWrite",
        points: metric(machine.cluster, name, machine.id)?.points ?? [],
    }));
}

export function chartSeriesRatio(
    machines: MachineData[],
    numerator: MetricName,
    denominator: MetricName,
): ChartSeries[] {
    return machines.map((machine) => {
        const total = new Map(
            metric(machine.cluster, denominator, machine.id)?.points.map((point) => [point.time, point.value]),
        );

        return {
            key: `${machine.key}:${numerator}/${denominator}`,
            machineKey: machine.key,
            label: `${machine.cluster.name} / ${machine.name}`,
            color: machine.color,
            points: metric(machine.cluster, numerator, machine.id)?.points.map((point) => {
                const value = total.get(point.time);
                return { time: point.time, value: point.value !== null && value ? (100 * point.value) / value : null };
            }) ?? [],
        };
    });
}

export function sumMachines(machines: MachineData[], name: MetricName) {
    const values = machines.map((machine) => machineValue(machine, name));

    return values.length && values.every((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null;
}

export function serviceRows(clusters: ClusterData[]): ServiceRow[] {
    return clusters.flatMap((cluster) =>
        cluster.services.map((service) => {
            const value = (name: MetricName) =>
                current(
                    metric(cluster, name, service.machineId, service.id),
                    cluster.end,
                    cluster.step,
                );

            const memory = value("serviceMemory");

            const total = current(
                metric(cluster, "memoryTotal", service.machineId),
                cluster.end,
                cluster.step,
            );

            return {
                ...service,
                key: `${cluster.id}:${service.id}:${service.machineId}`,
                clusterId: cluster.id,
                clusterName: cluster.name,
                cpu: value("serviceCpu"),
                memory,
                memoryPercent: memory !== null && total ? (100 * memory) / total : null,
                networkIn: value("serviceNetworkIn"),
                networkOut: value("serviceNetworkOut"),
                trend: metric(cluster, "serviceCpu", service.machineId, service.id)?.points ?? [],
            };
        }),
    );
}
