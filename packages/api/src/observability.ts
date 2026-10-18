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

/**
 * A volume's disk size, from the sidecar's `stoat_volume_size_bytes`, and the disk throughput of
 * the services that mount it, from cAdvisor's per-container counters. Docker volumes aren't
 * separate mounts, so no throughput is measured per volume itself.
 */
export const volumeMetricNames = ["volumeSize", "volumeRead", "volumeWrite"] as const;

export type VolumeMetricName = (typeof volumeMetricNames)[number];

const promRegex = (name: string) => name.replaceAll(/[^A-Za-z0-9_-]/gu, "\\$&");

/**
 * Series are labelled with the deployed names (`<slug>-<name>`), so no service lookup is needed.
 * The name goes in `container_label_uncloud_service_id`, the label every chart already groups by.
 */
export function volumeMetricQueries(
    clusterId: string,
    step: number,
    prefix: string | undefined,
    volume: string,
    services: string[],
    pinned?: string,
): Record<VolumeMetricName, string> {
    const scope = `customer_id=${JSON.stringify(clusterId)}`;
    const deployed = (name: string) => (prefix ? `${prefix}-${name}` : name);
    const names = services.map((name) => promRegex(deployed(name))).join("|");
    const window = `${Math.max(60, step * 2)}s`;

    const rate = (metric: string) =>
        `label_replace(sum by (machine_id, container_label_uncloud_service_name, name) (rate(${metric}{${scope},container_label_uncloud_service_name=~${JSON.stringify(names)}}[${window}])), "container_label_uncloud_service_id", "$1", "container_label_uncloud_service_name", "(.*)")`;

    return {
        volumeSize: `label_replace(max by (machine_id, volume) (stoat_volume_size_bytes{${scope},volume=${JSON.stringify(pinned ?? deployed(volume))}}), "container_label_uncloud_service_id", "$1", "volume", "(.*)")`,
        volumeRead: rate("container_fs_reads_bytes_total"),
        volumeWrite: rate("container_fs_writes_bytes_total"),
    };
}

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

function routedHosts(hosts: Map<string, string[]>) {
    return [...hosts].filter(([, names]) => names.length);
}

/**
 * One Caddy query covers every selected host, grouped by host, and each service's series is
 * summed from its hosts in parseServiceSeries. That is one scan instead of one `or` branch per
 * service, which GreptimeDB evaluates several times slower. (Tagging hosts with label_replace in
 * PromQL is not an option: GreptimeDB rewrites the label on series that don't match.)
 */
export type HttpQuery = {
    query: string;
    /** Series carry `host` and are summed into one series per service; otherwise kept as is. */
    perHost: boolean;
    /** The per-host series are `le` buckets, and each service gets this quantile of their sum. */
    quantile?: number;
};

/**
 * Splits services into groups of at most `limit` hostnames (a service is never split). A latency
 * chart returns ~12 `le` series per host, ~55 KB at 120 points, so it is queried a group at a time
 * to stay under the sidecar's 1 MiB response cap.
 */
export function hostGroups(hosts: Map<string, string[]>, limit = 8) {
    const groups: Map<string, string[]>[] = [];
    let group = new Map<string, string[]>();
    let size = 0;

    for (const [serviceId, names] of routedHosts(hosts)) {
        if (size && size + names.length > limit) {
            groups.push(group);
            group = new Map();
            size = 0;
        }

        group.set(serviceId, names);
        size += names.length;
    }

    if (size) groups.push(group);

    return groups;
}

/** HTTP metrics are Caddy's own per-host metrics, pushed over OTLP through Alloy. */
export function httpQueries(
    clusterId: string,
    step: number,
    hosts: Map<string, string[]>,
): Record<HttpMetricName, HttpQuery> | null {
    const names = routedHosts(hosts).flatMap(([, list]) => list);

    if (!names.length) return null;
    const window = `${Math.max(60, step * 2)}s`;
    const select = caddySelector(clusterId, names);
    const rate = (metric: string, extra?: string) => `rate(${select(metric, extra)}[${window}])`;

    const latency = (quantile: number): HttpQuery => ({
        query: `sum by (host, le) (${rate(caddyBuckets)})`,
        perHost: true,
        quantile,
    });

    return {
        httpRequests: { query: `sum by (host) (${rate(caddyRequests)})`, perHost: true },
        // `or … * 0` reports 0 instead of a gap while a host has traffic but no 5xx series yet.
        httpErrors: {
            query: `sum by (host) (${rate(caddyRequests, ',code=~"5.."')}) or sum by (host) (${rate(caddyRequests)}) * 0`,
            perHost: true,
        },
        httpLatency: latency(0.95),
        httpLatencyP50: latency(0.5),
        httpLatencyP99: latency(0.99),
        // One series per status class (2xx, 3xx, …) across all the selected services.
        httpStatus: {
            query: `sum by (status_class) (label_replace(${rate(caddyRequests)}, "status_class", "\${1}xx", "code", "([1-5]).."))`,
            perHost: false,
        },
        httpBandwidth: { query: `sum by (host) (${rate(caddyBytes)})`, perHost: true },
    };
}

/** Totals over the whole range, evaluated once at its end like counterTotalQuery. */
export function httpSummaryQueries(
    clusterId: string,
    duration: number,
    hosts: Map<string, string[]>,
) {
    const names = routedHosts(hosts).flatMap(([, list]) => list);

    if (!names.length) return null;
    const window = `${duration}s`;
    const select = caddySelector(clusterId, names);

    const increase = (metric: string, extra?: string) =>
        `increase(${select(metric, extra)}[${window}])`;

    // Four queries instead of one per figure: GreptimeDB slows down sharply when several range
    // scans run at once, so each metric is scanned once and split in summarizeServices and breakdown.
    return {
        // Per status code, so the errors are the 5xx part of the same scan.
        requests: `sum by (host, code) (${increase(caddyRequests)})`,
        bytes: `sum by (host) (${increase(caddyBytes)})`,
        // Summed per service, or across every host for the overall P95.
        latency: `sum by (host, le) (${increase(caddyBuckets)})`,
        visitors: `sum by (country, client, proto) (increase(${visitorRequests}{${hostMatcher(clusterId, names)}}[${window}]))`,
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

/** Samples on the `start + i * step` grid, with missing and non-finite ones as null. */
function onGrid(samples: [number, string][], start: number, end: number, step: number) {
    const byTime = new Map(samples);
    const values: (number | null)[] = [];

    for (let time = start; time <= end; time += step) {
        const raw = byTime.get(time);
        const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
        values.push(Number.isFinite(value) ? value : null);
    }

    return values;
}

// Four significant digits exceed what charts and the one-decimal labels can show.
function chartValue(value: number | null) {
    return value === null ? null : Number(Math.max(0, value).toPrecision(4));
}

/** Preserve missing samples as gaps, including disappeared machines and non-finite Prometheus values. */
export function parseMetricSeries(
    text: string,
    start: number,
    end: number,
    step: number,
): PackedMetricSeries[] {
    return matrix.parse(JSON.parse(text)).data.result.map((series) => {
        const values = onGrid(series.values, start, end, step).map(chartValue);

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

export type Total = { metric: Record<string, string>; value: number };

/** Reads a start=end range query as one value per series, leaving out the ones without a number. */
export function parseTotals(text: string): Total[] {
    return vector.parse(JSON.parse(text)).data.result.flatMap(({ metric, values }) => {
        const value = Number(values.at(-1)?.[1]);

        return Number.isFinite(value) ? [{ metric, value }] : [];
    });
}

function sumBy(totals: Total[], label: string) {
    const sums = new Map<string, number>();

    for (const { metric, value } of totals)
        sums.set(metric[label] ?? "", (sums.get(metric[label] ?? "") ?? 0) + value);

    return sums;
}

const sum = (totals: Total[]) => totals.reduce((all, { value }) => all + value, 0);

/** Requests per value of `label`. A series without the label (e.g. an IP with no known country) gets the empty key. */
export function breakdown(totals: Total[], label: string): HttpBreakdown[] {
    return [...sumBy(totals, label)].flatMap(([key, requests]) =>
        requests > 0 ? [{ key, requests }] : [],
    );
}

/** Prometheus' histogram_quantile over one set of cumulative `le` buckets; null without requests. */
export function histogramQuantile(quantile: number, buckets: [bound: number, count: number][]) {
    const sorted = buckets.toSorted(([a], [b]) => a - b);
    const [last, total = 0] = sorted.at(-1) ?? [];

    if (sorted.length < 2 || last !== Infinity || total <= 0) return null;
    const rank = quantile * total;
    let lower = 0;
    let below = 0;

    for (const [bound, cumulative] of sorted) {
        // Buckets are cumulative, but increase() extrapolation can dip one below the previous.
        const count = Math.max(cumulative, below);

        if (count >= rank)
            // Like Prometheus, a rank in the +Inf bucket answers with the highest finite bound.
            return bound === Infinity
                ? lower
                : lower + ((bound - lower) * (rank - below)) / (count - below);

        lower = bound;
        below = count;
    }

    return lower;
}

/**
 * Sums an HttpQuery's per-host series into one series per service, since a service can have
 * several hosts. With a quantile, the `le` buckets are summed and the quantile taken per sample.
 * Services without any series are left out, as PromQL would.
 */
function serviceValues(
    text: string,
    start: number,
    end: number,
    step: number,
    hosts: Map<string, string[]>,
    quantile?: number,
): [serviceId: string, values: (number | null)[]][] {
    const result = vector.parse(JSON.parse(text)).data.result;
    const length = Math.floor((end - start) / step) + 1;

    return routedHosts(hosts).flatMap(([serviceId, names]): [string, (number | null)[]][] => {
        // Keyed by `le` for a quantile; a plain sum has one key.
        const sums = new Map<string, (number | null)[]>();

        for (const { metric, values } of result) {
            if (!names.includes(metric.host ?? "")) continue;
            const key = quantile === undefined ? "" : (metric.le ?? "");
            const sum = sums.get(key) ?? Array<number | null>(length).fill(null);

            onGrid(values, start, end, step).forEach((value, index) => {
                if (value !== null) sum[index] = (sum[index] ?? 0) + value;
            });
            sums.set(key, sum);
        }

        if (!sums.size) return [];

        if (quantile === undefined) return [[serviceId, sums.get("") ?? []]];

        return [
            [
                serviceId,
                Array.from({ length }, (_, index) =>
                    histogramQuantile(
                        quantile,
                        [...sums].flatMap(([le, sum]): [number, number][] => {
                            const count = sum[index] ?? null;

                            return count === null
                                ? []
                                : [[le === "+Inf" ? Infinity : Number(le), count]];
                        }),
                    ),
                ),
            ],
        ];
    });
}

/** Chart series for a per-host HttpQuery, one per service. */
export function parseServiceSeries(
    text: string,
    start: number,
    end: number,
    step: number,
    hosts: Map<string, string[]>,
    quantile?: number,
): PackedMetricSeries[] {
    return serviceValues(text, start, end, step, hosts, quantile).map(([serviceId, values]) => ({
        machineId: "",
        serviceId,
        container: "",
        start,
        step,
        values: values.map(chartValue),
    }));
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

/** Quantile of the `le` bucket totals, summed across whatever hosts they cover; null without requests. */
export function bucketQuantile(quantile: number, totals: Total[]) {
    return histogramQuantile(
        quantile,
        [...sumBy(totals, "le")].map(([le, count]): [number, number] => [
            le === "+Inf" ? Infinity : Number(le),
            count,
        ]),
    );
}

/** One row per service with a hostname, including those without traffic. */
export function summarizeServices(
    hosts: Map<string, string[]>,
    requests: Total[],
    bytes: Total[],
    latency: Total[],
): HttpServiceSummary[] {
    return routedHosts(hosts).map(([serviceId, names]) => {
        const own = (totals: Total[]) =>
            totals.filter(({ metric }) => names.includes(metric.host ?? ""));

        const served = own(requests);

        return {
            serviceId,
            hosts: names,
            requests: Math.round(sum(served)),
            errors: Math.round(sum(served.filter(({ metric }) => metric.code?.startsWith("5")))),
            bytes: Math.round(sum(own(bytes))),
            latency: bucketQuantile(0.95, own(latency)),
        };
    });
}

/** The summary is streamed in these parts, each one as soon as its queries finish. */
export const httpSummaryParts = ["services", "latency", "visitors"] as const;

export type HttpSummaryPart = (typeof httpSummaryParts)[number];

export type HttpSummary = {
    status: "ok" | "no-routes" | "not-collecting";
    /** Parts still being queried; their fields keep empty values until they arrive. */
    pending: HttpSummaryPart[];
    services: HttpServiceSummary[];
    latency: number | null;
    /** Null until Alloy has counted the first access log with a config that records visitors. */
    visitors: {
        countries: HttpBreakdown[];
        clients: HttpBreakdown[];
        protocols: HttpBreakdown[];
    } | null;
};
