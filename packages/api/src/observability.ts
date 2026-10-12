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
    /** HTTP status class such as "2xx", for the httpStatus chart. */
    statusClass?: string;
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

/**
 * Wire format of a series: samples on the `start + i * step` grid (seconds), so timestamps aren't
 * sent per point. `unpackSeries` turns it back into points.
 */
export type PackedMetricSeries = Omit<MetricSeries, "points"> & {
    start: number;
    step: number;
    values: (number | null)[];
};

export function unpackSeries({ start, step, values, ...labels }: PackedMetricSeries): MetricSeries {
    return {
        ...labels,
        points: values.map((value, index) => ({ time: (start + index * step) * 1000, value })),
    };
}

/** Point budgets a chart can ask for: sparklines need few, full charts about one per few pixels. */
export const chartPoints = [24, 120] as const;

export type ChartPoints = (typeof chartPoints)[number];

export type MetricWindow = { start: number; end: number; step: number; duration: number };

/** Align a range to the 15s scrape grid with at most `points` samples (like Grafana's maxDataPoints). */
export function metricWindow(
    range: ObservabilityRange,
    points: ChartPoints = 120,
    nowSeconds = Date.now() / 1000,
): MetricWindow {
    const now = Math.floor(nowSeconds / 15) * 15;
    const end = range instanceof Object ? Math.min(now, Math.floor(range.to / 15) * 15) : now;
    const duration = range instanceof Object ? Math.max(60, end - range.from) : ranges[range];
    const step = Math.max(15, Math.ceil(duration / points / 15) * 15);

    return { start: end - Math.ceil(duration / step) * step, end, step, duration };
}

export const httpMetricNames = [
    "httpRequests",
    "httpErrors",
    "httpLatency",
    "httpLatencyP50",
    "httpLatencyP99",
] as const;

/** The HTTP traffic page's charts; resource pages chart httpMetricNames. */
export const httpTrafficMetricNames = [
    "httpRequests",
    "httpStatus",
    "httpLatency",
    "httpBandwidth",
] as const;

export type HttpMetricName =
    | (typeof httpMetricNames)[number]
    | (typeof httpTrafficMetricNames)[number];

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

// caddy_http_requests_total has no status code, so requests are counted from the histogram.
const caddyRequests = "caddy_http_request_duration_seconds_count";

const caddyBuckets = "caddy_http_request_duration_seconds_bucket";

const caddyBytes = "caddy_http_response_size_bytes_sum";

/** Counted by Alloy from Caddy's access logs, with country, client, and proto labels. */
export const visitorRequests = "loki_process_custom_http_visitor_requests_total";

/** Every table the HTTP traffic charts and summary query. */
export const caddyMetricTables = [caddyRequests, caddyBuckets, caddyBytes] as const;

type Selector = (metric: string, extra?: string) => string;

// Hostnames match hostnamePattern, so escaping dots is the only regex quoting needed.
function hostMatcher(clusterId: string, names: string[]) {
    return `customer_id=${JSON.stringify(clusterId)},host=~${JSON.stringify(names.map((name) => name.replaceAll(".", "\\.")).join("|"))}`;
}

/** Selects Caddy series for these hosts. Sites always run as a subroute, which leaves out automatic HTTP-to-HTTPS redirects. */
function caddySelector(clusterId: string, names: string[]): Selector {
    return (metric, extra = "") =>
        `${metric}{${hostMatcher(clusterId, names)},handler="subroute"${extra}}`;
}

/**
 * Hosts are mapped back to services here, one `or` branch per service, so each series carries
 * its service ID.
 */
function perService(
    clusterId: string,
    hosts: [string, string[]][],
    build: (selector: Selector) => string,
) {
    return hosts
        .map(
            ([serviceId, names]) =>
                `label_replace(${build(caddySelector(clusterId, names))}, "container_label_uncloud_service_id", ${JSON.stringify(serviceId)}, "", "")`,
        )
        .join(" or ");
}

function routedHosts(hosts: Map<string, string[]>) {
    return [...hosts].filter(([, names]) => names.length);
}

/** HTTP metrics are Caddy's own per-host metrics, pushed over OTLP through Alloy. */
export function httpQueries(
    clusterId: string,
    step: number,
    hosts: Map<string, string[]>,
): Record<HttpMetricName, string> | null {
    const entries = routedHosts(hosts);

    if (!entries.length) return null;
    const window = `${Math.max(60, step * 2)}s`;

    const all = caddySelector(
        clusterId,
        entries.flatMap(([, names]) => names),
    );

    const latency = (quantile: number) => (selector: Selector) =>
        `histogram_quantile(${quantile}, sum by (le) (rate(${selector(caddyBuckets)}[${window}])))`;

    return {
        httpRequests: perService(
            clusterId,
            entries,
            (selector) => `sum(rate(${selector(caddyRequests)}[${window}]))`,
        ),
        // `or … * 0` reports 0 instead of a gap while there is traffic but no 5xx series yet.
        httpErrors: perService(
            clusterId,
            entries,
            (selector) =>
                `(sum(rate(${selector(caddyRequests, ',code=~"5.."')}[${window}])) or sum(rate(${selector(caddyRequests)}[${window}])) * 0)`,
        ),
        httpLatency: perService(clusterId, entries, latency(0.95)),
        httpLatencyP50: perService(clusterId, entries, latency(0.5)),
        httpLatencyP99: perService(clusterId, entries, latency(0.99)),
        // One series per status class (2xx, 3xx, …) across all the selected services.
        httpStatus: `sum by (status_class) (label_replace(rate(${all(caddyRequests)}[${window}]), "status_class", "\${1}xx", "code", "([1-5]).."))`,
        httpBandwidth: perService(
            clusterId,
            entries,
            (selector) => `sum(rate(${selector(caddyBytes)}[${window}]))`,
        ),
    };
}

/** Totals over the whole range, evaluated once at its end like counterTotalQuery. */
export function httpSummaryQueries(
    clusterId: string,
    duration: number,
    hosts: Map<string, string[]>,
) {
    const entries = routedHosts(hosts);

    if (!entries.length) return null;
    const window = `${duration}s`;
    const names = entries.flatMap(([, list]) => list);

    const visitors = (label: string) =>
        `sum by (${label}) (increase(${visitorRequests}{${hostMatcher(clusterId, names)}}[${window}]))`;

    return {
        requests: perService(
            clusterId,
            entries,
            (selector) => `sum(increase(${selector(caddyRequests)}[${window}]))`,
        ),
        errors: perService(
            clusterId,
            entries,
            (selector) => `sum(increase(${selector(caddyRequests, ',code=~"5.."')}[${window}]))`,
        ),
        bytes: perService(
            clusterId,
            entries,
            (selector) => `sum(increase(${selector(caddyBytes)}[${window}]))`,
        ),
        latency: perService(
            clusterId,
            entries,
            (selector) =>
                `histogram_quantile(0.95, sum by (le) (increase(${selector(caddyBuckets)}[${window}])))`,
        ),
        // Per-service P95s cannot be combined, so the overall one is its own query.
        totalLatency: `histogram_quantile(0.95, sum by (le) (increase(${caddySelector(clusterId, names)(caddyBuckets)}[${window}])))`,
        countries: visitors("country"),
        clients: visitors("client"),
        protocols: visitors("proto"),
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
                    status_class: z.string().optional(),
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
): PackedMetricSeries[] {
    return matrix.parse(JSON.parse(text)).data.result.map((series) => {
        const samples = new Map(series.values);
        const values: (number | null)[] = [];

        for (let time = start; time <= end; time += step) {
            const raw = samples.get(time);
            const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
            // Four significant digits exceed what charts and the one-decimal labels can show.
            values.push(Number.isFinite(value) ? Number(Math.max(0, value).toPrecision(4)) : null);
        }

        return {
            machineId: series.metric.machine_id ?? "",
            serviceId: series.metric.container_label_uncloud_service_id ?? "",
            container: series.metric.name ?? "",
            device: series.metric.device,
            mountpoint: series.metric.mountpoint,
            fstype: series.metric.fstype,
            statusClass: series.metric.status_class,
            start,
            step,
            values,
        };
    });
}

const vector = z.object({
    status: z.literal("success"),
    data: z.object({
        result: z.array(
            z.object({
                metric: z.record(z.string(), z.string()),
                values: z.array(z.tuple([z.number().finite(), z.string()])),
            }),
        ),
    }),
});

export type HttpBreakdown = { key: string; requests: number };

/**
 * Reads a start=end range query as one value per series, keyed by `label`. A series without the
 * label (e.g. requests from an IP with no known country) gets the empty key.
 */
export function parseTotals(text: string, label: string): HttpBreakdown[] {
    return vector.parse(JSON.parse(text)).data.result.flatMap((series) => {
        const value = Number(series.values.at(-1)?.[1]);

        return Number.isFinite(value) && value > 0
            ? [{ key: series.metric[label] ?? "", requests: value }]
            : [];
    });
}

export type HttpServiceSummary = {
    serviceId: string;
    /** Ingress hostnames the figures cover. */
    hosts: string[];
    requests: number;
    errors: number;
    bytes: number;
    /** P95 in seconds; null without requests. */
    latency: number | null;
};

export type HttpSummary = {
    status: "ok" | "no-routes" | "not-collecting";
    services: HttpServiceSummary[];
    latency: number | null;
    /** Null until Alloy has counted the first access log with a config that records visitors. */
    visitors: {
        countries: HttpBreakdown[];
        clients: HttpBreakdown[];
        protocols: HttpBreakdown[];
    } | null;
};
