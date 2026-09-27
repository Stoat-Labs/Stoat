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

/** `container` is the Docker container name for per-container service metrics, otherwise empty. */
export type MetricSeries = {
    machineId: string;
    serviceId: string;
    container: string;
    points: MetricPoint[];
};

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

export const httpMetricNames = ["httpRequests", "httpErrors", "httpLatency"] as const;

export type HttpMetricName = (typeof httpMetricNames)[number];

/** Limits are null when the container is unlimited. */
export type ObservabilityContainer = {
    id: string;
    name: string;
    machineId: string;
    machineName: string;
    running: boolean;
    state: string;
    health: string | null;
    restarts: number;
    oomKilled: boolean;
    startedAt: string | null;
    memoryLimit: number | null;
    cpuLimit: number | null;
};

export type ObservabilityService = {
    id: string;
    name: string;
    href: string | null;
    containers: ObservabilityContainer[];
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

/** Uncloud service IDs are hex; the pattern also keeps them safe inside a PromQL regex matcher. */
export const serviceIdPattern = /^[\w-]+$/;

export function metricQueries(
    clusterId: string,
    step: number,
    serviceIds: string[] = [],
): Record<MetricName, string> {
    // IDs are validated at the procedure boundary; JSON quoting also escapes PromQL strings.
    const scope = `customer_id=${JSON.stringify(clusterId)}`;

    const services = serviceIds.length
        ? `container_label_uncloud_service_id=~${JSON.stringify(serviceIds.join("|"))}`
        : 'container_label_uncloud_service_id!=""';

    const window = `${Math.max(60, step * 2)}s`;
    const host = (metric: string, extra = "") => `${metric}{${scope}${extra}}`;

    const rate = (metric: string, extra = "") =>
        `sum by (machine_id) (rate(${host(metric, extra)}[${window}]))`;

    const gauge = (metric: string, extra = "") => `max by (machine_id) (${host(metric, extra)})`;

    // Per container (cAdvisor's `name` label); service totals are summed client-side.
    const service = (metric: string, counter = false) => {
        const selector = host(metric, `,${services}`);

        return `sum by (machine_id, container_label_uncloud_service_id, name) (${counter ? `rate(${selector}[${window}])` : selector})`;
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

const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Ingress hostnames from Uncloud's `uncloud.service.ports` label
 * (`[hostname:][published:]container/protocol`, comma-separated). Host-mode ports have no hostname.
 */
export function serviceHosts(label: string | undefined) {
    const hosts = new Set<string>();

    for (const port of label?.split(",") ?? []) {
        const [address = "", protocol] = port.trim().split("/");
        const first = address.split(":")[0]?.toLowerCase() ?? "";

        if ((protocol === "http" || protocol === "https") && hostnamePattern.test(first))
            hosts.add(first);
    }

    return [...hosts];
}

/**
 * HTTP metrics come from Caddy access logs, which Alloy turns into per-host counters. Hosts are
 * mapped back to services here, one `or` branch per service, so each series carries its service ID.
 */
export function httpQueries(
    clusterId: string,
    step: number,
    hosts: Map<string, string[]>,
): Record<HttpMetricName, string> | null {
    const entries = [...hosts].filter(([, names]) => names.length);

    if (!entries.length) return null;
    const window = `${Math.max(60, step * 2)}s`;

    const each = (build: (selector: (metric: string, extra?: string) => string) => string) =>
        entries
            .map(([serviceId, names]) => {
                // Hostnames match hostnamePattern, so escaping dots is the only regex quoting needed.
                const matcher = `customer_id=${JSON.stringify(clusterId)},http_host=~${JSON.stringify(names.map((name) => name.replaceAll(".", "\\.")).join("|"))}`;

                return `label_replace(${build((metric, extra = "") => `${metric}{${matcher}${extra}}`)}, "container_label_uncloud_service_id", ${JSON.stringify(serviceId)}, "", "")`;
            })
            .join(" or ");

    const requests = "loki_process_custom_http_requests_total";
    const buckets = "loki_process_custom_http_request_duration_seconds_bucket";

    return {
        httpRequests: each((selector) => `sum(rate(${selector(requests)}[${window}]))`),
        // `or … * 0` reports 0 instead of a gap while there is traffic but no 5xx series yet.
        httpErrors: each(
            (selector) =>
                `(sum(rate(${selector(requests, ',http_status=~"5.."')}[${window}])) or sum(rate(${selector(requests)}[${window}])) * 0)`,
        ),
        httpLatency: each(
            (selector) =>
                `histogram_quantile(0.95, sum by (le) (rate(${selector(buckets)}[${window}])))`,
        ),
    };
}

const matrix = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("matrix"),
        result: z.array(
            z.object({
                metric: z.object({
                    machine_id: z.string().optional(),
                    container_label_uncloud_service_id: z.string().optional(),
                    name: z.string().optional(),
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
            machineId: series.metric.machine_id ?? "",
            serviceId: series.metric.container_label_uncloud_service_id ?? "",
            container: series.metric.name ?? "",
            points,
        };
    });
}
