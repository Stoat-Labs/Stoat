import { z } from "zod";

export const rangePresets = ["1h", "6h", "12h", "24h", "3d", "7d", "14d", "30d"] as const;

export type RangePreset = (typeof rangePresets)[number];

export type ObservabilityRange = RangePreset | { from: number; to: number };

export const ranges: Record<RangePreset, number> = {
    "1h": 3600,
    "6h": 21600,
    "12h": 43200,
    "24h": 86400,
    "3d": 259200,
    "7d": 604800,
    "14d": 1209600,
    "30d": 2592000,
};

export type MetricPoint = { time: number; value: number | null };

export type MetricSeries = { machineId: string; serviceId: string; points: MetricPoint[] };

export const metricNames = [
    "cpu",
    "cores",
    "memory",
    "memoryTotal",
    "disk",
    "diskTotal",
    "networkIn",
    "networkOut",
    "diskRead",
    "diskWrite",
    "serviceCpu",
    "serviceMemory",
    "serviceNetworkIn",
    "serviceNetworkOut",
] as const;

export type MetricName = (typeof metricNames)[number];

export type MetricWindow = { start: number; end: number; step: number; duration: number };

/** Align a range to the 15s scrape grid with about as many points as a chart can draw (like Grafana's maxDataPoints). */
export function metricWindow(
    range: ObservabilityRange,
    nowSeconds = Date.now() / 1000,
): MetricWindow {
    const now = Math.floor(nowSeconds / 15) * 15;
    const end = range instanceof Object ? Math.min(now, Math.floor(range.to / 15) * 15) : now;
    const duration = range instanceof Object ? Math.max(60, end - range.from) : ranges[range];
    const step = Math.max(15, Math.ceil(duration / 120 / 15) * 15);

    return { start: end - Math.ceil(duration / step) * step, end, step, duration };
}

export type ObservabilityService = {
    id: string;
    name: string;
    machineId: string;
    machineName: string;
    running: number;
    containers: number;
    href: string | null;
};

export type ClusterObservability = {
    available: boolean;
    reason?: "uninitialized" | "unreachable";
    start: number;
    end: number;
    step: number;
    machines: { id: string; name: string; state: string }[];
    services: ObservabilityService[];
    metrics: Partial<Record<MetricName, MetricSeries[]>>;
    unavailable: string[];
};

export function metricQueries(clusterId: string, step: number): Record<MetricName, string> {
    // IDs are validated UUIDs at the procedure boundary; JSON quoting also escapes PromQL strings.
    const scope = `customer_id=${JSON.stringify(clusterId)}`;
    const window = `${Math.max(60, step * 2)}s`;
    const host = (metric: string, extra = "") => `${metric}{${scope}${extra}}`;

    const rate = (metric: string, extra = "") =>
        `sum by (machine_id) (rate(${host(metric, extra)}[${window}]))`;

    const gauge = (metric: string, extra = "") => `max by (machine_id) (${host(metric, extra)})`;

    const service = (metric: string, counter = false) => {
        const selector = host(metric, ',container_label_uncloud_service_id!=""');

        return `sum by (machine_id, container_label_uncloud_service_id) (${counter ? `rate(${selector}[${window}])` : selector})`;
    };

    // Exclude guest modes (already included in user/nice) and virtual host interfaces to avoid double counting.
    const interfaces = ',device!~"lo|veth.*|docker.*|br-.*|virbr.*|uc.*|wg.*"';
    const disks = ',device!~"loop.*|ram.*|dm-.*"';

    return {
        cpu: `100 * ${rate("node_cpu_seconds_total", ',mode!~"idle|guest|guest_nice"')}`,
        cores: `count by (machine_id) (${host("node_cpu_seconds_total", ',mode="idle"')})`,
        memory: `${gauge("node_memory_MemTotal_bytes")} - ${gauge("node_memory_MemAvailable_bytes")}`,
        memoryTotal: gauge("node_memory_MemTotal_bytes"),
        disk: `${gauge("node_filesystem_size_bytes", ',mountpoint="/"')} - ${gauge("node_filesystem_avail_bytes", ',mountpoint="/"')}`,
        diskTotal: gauge("node_filesystem_size_bytes", ',mountpoint="/"'),
        networkIn: rate("node_network_receive_bytes_total", interfaces),
        networkOut: rate("node_network_transmit_bytes_total", interfaces),
        diskRead: rate("node_disk_read_bytes_total", disks),
        diskWrite: rate("node_disk_written_bytes_total", disks),
        serviceCpu: `100 * ${service("container_cpu_usage_seconds_total", true)}`,
        serviceMemory: service("container_memory_working_set_bytes"),
        serviceNetworkIn: service("container_network_receive_bytes_total", true),
        serviceNetworkOut: service("container_network_transmit_bytes_total", true),
    };
}

const matrix = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("matrix"),
        result: z.array(
            z.object({
                metric: z.object({
                    machine_id: z.string(),
                    container_label_uncloud_service_id: z.string().optional(),
                }),
                values: z.array(z.tuple([z.number().finite(), z.string()])),
            }),
        ),
    }),
});

/** Preserve missing samples as gaps, including disappeared machines and non-finite Prometheus values. */
export function parseMetricSeries(
    text: string,
    start: number,
    end: number,
    step: number,
): MetricSeries[] {
    return matrix.parse(JSON.parse(text)).data.result.map((series) => {
        const values = new Map(series.values);
        const points: MetricPoint[] = [];

        for (let time = start; time <= end; time += step) {
            const raw = values.get(time);
            const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
            points.push({
                time: time * 1000,
                // Four significant digits exceed what charts and the one-decimal labels can show.
                value: Number.isFinite(value) ? Number(Math.max(0, value).toPrecision(4)) : null,
            });
        }

        return {
            machineId: series.metric.machine_id,
            serviceId: series.metric.container_label_uncloud_service_id ?? "",
            points,
        };
    });
}
