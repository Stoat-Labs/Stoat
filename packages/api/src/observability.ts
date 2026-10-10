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
    device?: string;
    mountpoint?: string;
    fstype?: string;
    points: MetricPoint[];
};

export const metricNames = [
    "cpu",
    "cores",
    "memory",
    "memoryTotal",
    "disk",
    "diskTotal",
    "filesystemUsed",
    "filesystemTotal",
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

export const httpMetricNames = [
    "httpRequests",
    "httpErrors",
    "httpLatency",
    "httpLatencyP50",
    "httpLatencyP99",
] as const;

export type HttpMetricName = (typeof httpMetricNames)[number];

export const dnsMetricNames = ["dnsQueries", "dnsErrors", "dnsAvailability"] as const;

export type DnsMetricName = (typeof dnsMetricNames)[number];

export type MachineMetricName = MetricName | DnsMetricName;

export const postgresMetricNames = [
    "postgresConnections",
    "postgresMaxConnections",
    "postgresTransactions",
    "postgresCacheHit",
    "postgresSize",
] as const;

export type PostgresMetricName = (typeof postgresMetricNames)[number];

/** Tables postgres-exporter's default collectors create once Alloy scrapes the first sample. */
export const postgresMetricTables = [
    "pg_stat_database_numbackends",
    "pg_settings_max_connections",
    "pg_stat_database_xact_commit",
    "pg_stat_database_xact_rollback",
    "pg_stat_database_blks_hit",
    "pg_stat_database_blks_read",
    "pg_database_size_bytes",
] as const;

/** postgres-exporter series, scoped to the exporter services Alloy tagged with their Uncloud service ID. */
export function postgresMetricQueries(
    clusterId: string,
    step: number,
    serviceIds: string[],
): Record<PostgresMetricName, string> {
    // IDs are validated at the procedure boundary; JSON quoting also escapes PromQL strings.
    const scope = `customer_id=${JSON.stringify(clusterId)},container_label_uncloud_service_id=~${JSON.stringify(serviceIds.join("|"))}`;
    // Template databases are never connected to and only add noise to sizes.
    const databases = `${scope},datname!~"template.*"`;
    const window = `${Math.max(60, step * 2)}s`;

    const rate = (metric: string) =>
        `sum by (machine_id) (rate(${metric}{${databases}}[${window}]))`;

    const blocks = `${rate("pg_stat_database_blks_hit")} + ${rate("pg_stat_database_blks_read")}`;

    return {
        postgresConnections: `sum by (machine_id) (pg_stat_database_numbackends{${databases}})`,
        postgresMaxConnections: `max by (machine_id) (pg_settings_max_connections{${scope}})`,
        postgresTransactions: `${rate("pg_stat_database_xact_commit")} + ${rate("pg_stat_database_xact_rollback")}`,
        // An idle database reads no blocks, which leaves a gap rather than a misleading 0%.
        postgresCacheHit: `100 * ${rate("pg_stat_database_blks_hit")} / (${blocks})`,
        postgresSize: `sum by (machine_id) (pg_database_size_bytes{${databases}})`,
    };
}

export function dnsMetricQueries(clusterId: string, step: number): Record<DnsMetricName, string> {
    const scope = `customer_id=${JSON.stringify(clusterId)},job="prometheus.scrape.uncloud"`;
    const window = Math.max(60, step * 2);

    return {
        dnsQueries: `sum by (machine_id) (rate(uncloud_dns_query_total{${scope}}[${window}s]))`,
        dnsErrors: `(sum by (machine_id) (rate(uncloud_dns_query_total{${scope},status="err"}[${window}s]))) or (0 * sum by (machine_id) (rate(uncloud_dns_query_total{${scope}}[${window}s])))`,
        // `up` is binary scrape health, not an availability percentage. Preserve any failure
        // inside each chart interval instead of dropping it when a long range is downsampled.
        dnsAvailability: `min by (machine_id) (min_over_time(up{${scope}}[${step}s]))`,
    };
}

/** Counter increases are evaluated once at the range end, not integrated from chart samples. */
export function counterTotalQuery(query: string, duration: number) {
    return query.replaceAll("rate(", "increase(").replace(/\[\d+s\]/g, `[${duration}s]`);
}

/** Limits are null when the container is unlimited. */
export type ObservabilityContainer = {
    id: string;
    name: string;
    /** The image reference as written in the Compose file, e.g. `postgres:18-alpine`. */
    image: string;
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

/** Repository name without registry, namespace, tag, or digest: `docker.io/library/postgres:18` → `postgres`. */
function imageRepository(image: string) {
    const [reference = ""] = image.split("@");

    return reference.split("/").at(-1)?.split(":")[0] ?? "";
}

/** Postgres metrics exist when services run both a Postgres server and postgres-exporter next to it. */
export function hasPostgresExporter(services: ObservabilityService[]) {
    const repositories = new Set(
        services.flatMap((service) =>
            service.containers.map((container) => imageRepository(container.image)),
        ),
    );

    return (
        repositories.has("postgres") &&
        (repositories.has("postgres-exporter") || repositories.has("postgres_exporter"))
    );
}

export type ClusterObservability = {
    available: boolean;
    reason?: "uninitialized" | "unreachable";
    start: number;
    end: number;
    step: number;
    machines: { id: string; name: string; state: string }[];
    services: ObservabilityService[];
    metrics: Partial<Record<MachineMetricName, MetricSeries[]>>;
    unavailable: string[];
    totals?: Partial<Record<MachineMetricName, MetricSeries[]>>;
};

/** Uncloud service IDs are hex; the pattern also keeps them safe inside a PromQL regex matcher. */
export const serviceIdPattern = /^[\w-]+$/;

/** Memory-backed and virtual mounts aren't disk capacity. Keep other filesystem types discoverable. */
export const excludedFilesystemTypes =
    "^(autofs|aufs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|ramfs|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tmpfs|tracefs)$";

/** Boot partitions aren't application storage. Keep root and data mounts regardless of device name. */
export const excludedFilesystemMounts = "^/boot($|/.*)";

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
    // `uncloud` is the WireGuard mesh, whose traffic is already counted on the physical NIC.
    const interfaces = ',device!~"lo|veth.*|docker.*|br-.*|virbr.*|uncloud|uc.*|wg.*"';
    const disks = ',device!~"loop.*|ram.*|dm-.*"';

    const filesystem = (metric: string) =>
        host(
            metric,
            `,fstype!~${JSON.stringify(excludedFilesystemTypes)},mountpoint!~${JSON.stringify(excludedFilesystemMounts)}`,
        );

    // A filesystem can have several bind mounts. Count its capacity once per device, not per mount.
    const disk = (metric: string) =>
        `sum by (machine_id) (max by (machine_id, device, fstype) (${filesystem(metric)}))`;

    const mounted = (metric: string) =>
        `max by (machine_id, device, mountpoint, fstype) (${filesystem(metric)})`;

    return {
        cpu: `100 * ${rate("node_cpu_seconds_total", ',mode!~"idle|guest|guest_nice"')}`,
        cores: `count by (machine_id) (${host("node_cpu_seconds_total", ',mode="idle"')})`,
        memory: `${gauge("node_memory_MemTotal_bytes")} - ${gauge("node_memory_MemAvailable_bytes")}`,
        memoryTotal: gauge("node_memory_MemTotal_bytes"),
        disk: `${disk("node_filesystem_size_bytes")} - ${disk("node_filesystem_avail_bytes")}`,
        diskTotal: disk("node_filesystem_size_bytes"),
        filesystemUsed: `${mounted("node_filesystem_size_bytes")} - ${mounted("node_filesystem_avail_bytes")}`,
        filesystemTotal: mounted("node_filesystem_size_bytes"),
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

    const latency = (quantile: number) => (selector: (metric: string, extra?: string) => string) =>
        `histogram_quantile(${quantile}, sum by (le) (rate(${selector(buckets)}[${window}])))`;

    return {
        httpRequests: each((selector) => `sum(rate(${selector(requests)}[${window}]))`),
        // `or … * 0` reports 0 instead of a gap while there is traffic but no 5xx series yet.
        httpErrors: each(
            (selector) =>
                `(sum(rate(${selector(requests, ',http_status=~"5.."')}[${window}])) or sum(rate(${selector(requests)}[${window}])) * 0)`,
        ),
        httpLatency: each(latency(0.95)),
        httpLatencyP50: each(latency(0.5)),
        httpLatencyP99: each(latency(0.99)),
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
                    device: z.string().optional(),
                    mountpoint: z.string().optional(),
                    fstype: z.string().optional(),
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
            device: series.metric.device,
            mountpoint: series.metric.mountpoint,
            fstype: series.metric.fstype,
            points,
        };
    });
}
