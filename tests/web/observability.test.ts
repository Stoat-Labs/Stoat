import { ORPCError } from "@orpc/client";
import {
    hasMysqlExporter,
    hasPostgresExporter,
    isMysqlExporter,
    isPostgresExporter,
    histogramQuantile,
    hostGroups,
    httpQueries,
    metricNames,
    parseMetricSeries,
    parseServiceSeries,
    serviceHosts,
    unpackSeries,
    type ObservabilityContainer,
} from "../../packages/api/src/observability";
import { expect, it } from "vite-plus/test";
import {
    assembleCluster,
    bridgeGaps,
    chartSeries,
    chartSeriesRatio,
    current,
    filesystemRows,
    machineList,
    machinesUsage,
    scaleSeries,
    usageLevel,
    usageText,
    percent,
    containerHealth,
    serviceHealth,
    serviceRows,
    serviceSeries,
    rankMemory,
    type ClusterData,
} from "../../apps/web/src/lib/observability";

const container = (overrides: Partial<ObservabilityContainer>): ObservabilityContainer => ({
    id: "c1",
    name: "web-1",
    image: "nginx:1.29",
    machineId: "node",
    machineName: "Node",
    running: true,
    state: "running",
    health: null,
    restarts: 0,
    oomKilled: false,
    startedAt: null,
    memoryLimit: null,
    cpuLimit: null,
    ...overrides,
});

const healthCluster = (containers: ObservabilityContainer[]): ClusterData => ({
    id: "a",
    name: "A",
    available: true,
    start: 0,
    end: 60,
    step: 15,
    unavailable: [],
    machines: [],
    services: [{ id: "web", name: "Web", resource: null, containers }],
    metrics: {},
});

const healthAt = (containers: ObservabilityContainer[], now: number) =>
    serviceHealth(serviceRows([healthCluster(containers)])[0]!, now);

it("flags only live problems in a service's health", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

    expect(healthAt([container({})], now)).toEqual({ level: "ok", reason: "1/1 running" });
    expect(healthAt([], now)).toEqual({ level: "warning", reason: "No containers" });

    // Restarts never reset, so an old one must not flag the service forever.
    expect(healthAt([container({ restarts: 3, startedAt: minutesAgo(90) })], now).level).toBe("ok");

    expect(healthAt([container({ restarts: 4290, startedAt: minutesAgo(2) })], now)).toEqual({
        level: "warning",
        reason: "Restarted recently · 4290 restarts",
    });

    expect(
        healthAt([container({ running: false, state: "restarting", restarts: 1 })], now),
    ).toEqual({ level: "warning", reason: "0/1 running · Restarted recently · 1 restart" });

    expect(
        healthAt([container({}), container({ id: "c2", running: false, state: "exited" })], now),
    ).toEqual({ level: "warning", reason: "1/2 running" });

    expect(healthAt([container({ health: "unhealthy" })], now)).toEqual({
        level: "error",
        reason: "1 unhealthy",
    });

    const [row] = serviceRows([healthCluster([container({ restarts: 3, oomKilled: true })])]);

    expect(containerHealth(row!.containers[0]!, now)).toEqual({
        level: "error",
        reason: "running · OOM killed · 3 restarts",
    });
});

it("measures unlimited services against each machine's capacity once", () => {
    const sample = (name: string, machineId: string, value: number, serviceId = "") => ({
        name,
        machineId,
        serviceId,
        container: "",
        points: [{ time: 60000, value }],
    });

    const cluster: ClusterData = {
        ...healthCluster([
            container({}),
            container({ id: "c2", name: "web-2" }),
            container({ id: "c3", name: "web-3", machineId: "other" }),
        ]),
        metrics: {
            cores: [sample("cores", "node", 4), sample("cores", "other", 4)],
            memoryTotal: [
                sample("memoryTotal", "node", 1000),
                sample("memoryTotal", "other", 1000),
            ],
            serviceCpu: [sample("serviceCpu", "node", 200, "web")],
            serviceMemory: [sample("serviceMemory", "node", 500, "web")],
        },
    };

    expect(serviceRows([cluster])[0]).toMatchObject({ cpuPercent: 25, memoryPercent: 25 });

    // Without every machine's capacity the share would be overstated, so there is none.
    const { memoryTotal: _, ...partial } = cluster.metrics;

    expect(serviceRows([{ ...cluster, metrics: partial }])[0]).toMatchObject({
        cpuPercent: 25,
        memoryPercent: null,
    });
});

it("detects Postgres metrics from a Postgres server and postgres-exporter in any services", () => {
    const services = (...images: string[]) =>
        images.map((image, index) => ({
            id: `s${index}`,
            name: `service-${index}`,
            resource: null,
            containers: [container({ image })],
        }));

    expect(
        hasPostgresExporter(
            services("postgres:18-alpine", "prometheuscommunity/postgres-exporter:v0.20.1"),
        ),
    ).toBe(true);
    expect(
        hasPostgresExporter(
            services(
                "docker.io/library/postgres@sha256:abc",
                "quay.io/prometheuscommunity/postgres-exporter",
            ),
        ),
    ).toBe(true);
    expect(hasPostgresExporter(services("postgres:18", "wrouesnel/postgres_exporter"))).toBe(true);
    expect(
        hasPostgresExporter(services("timescale/timescaledb:2.31.0-pg18", "postgres-exporter")),
    ).toBe(true);
    expect(hasPostgresExporter(services("postgres:18-alpine"))).toBe(false);
    expect(hasPostgresExporter(services("mysql:9", "postgres-exporter"))).toBe(false);
    expect(
        services("postgres:18", "prometheuscommunity/postgres-exporter:v0.20.1").map(
            isPostgresExporter,
        ),
    ).toEqual([false, true]);
});

it("matches filesystem usage by machine, device, mount and type, preserving missing samples", () => {
    const samples = (values: [string, string, string, string][]) =>
        parseMetricSeries(
            JSON.stringify({
                status: "success",
                data: {
                    resultType: "matrix",
                    result: values.map(([machine_id, device, mountpoint, value]) => ({
                        metric: { machine_id, device, mountpoint, fstype: "ext4" },
                        values: [[60, value]],
                    })),
                },
            }),
            45,
            60,
            15,
        ).map(unpackSeries);

    const cluster: ClusterData = {
        id: "a",
        name: "A",
        available: true,
        start: 45,
        end: 60,
        step: 15,
        unavailable: [],
        services: [],
        machines: [{ id: "node", name: "Node", state: "Up" }],
        metrics: {
            filesystemTotal: samples([
                ["node", "/dev/vda1", "/", "100"],
                ["node", "/dev/vdb1", "/data", "200"],
                ["node", "/dev/vdc1", "/missing", "300"],
            ]),
            filesystemUsed: samples([
                ["node", "/dev/vdb1", "/data", "190"],
                ["node", "/dev/vda1", "/", "20"],
                ["other", "/dev/vdc1", "/missing", "300"],
            ]),
        },
    };

    const rows = filesystemRows(machineList([cluster, { ...cluster, id: "b" }]));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.key)).size).toBe(6);
    expect(rows.every((row) => !/[.[\]]/.test(row.key))).toBe(true);
    expect(
        rows.find((row) => row.machineKey === "a:node" && row.mountpoint === "/data"),
    ).toMatchObject({
        device: "/dev/vdb1",
        used: 190,
        total: 200,
        percent: 95,
        points: [
            { time: 45000, value: null },
            { time: 60000, value: 95 },
        ],
    });
    expect(rows.find((row) => row.mountpoint === "/missing")).toMatchObject({
        used: null,
        percent: null,
    });
    expect(filesystemRows(machineList([{ ...cluster, end: 90 }]))[0]?.percent).toBeNull();
});

it("keeps machine and service identities cluster-scoped and CPU above 100%, without replacing missing data with zero", () => {
    const base: ClusterData = {
        id: "a",
        name: "A",
        available: true,
        start: 0,
        end: 60,
        step: 15,
        unavailable: [],
        machines: [{ id: "node", name: "Node", state: "Up" }],
        services: [{ id: "web", name: "Web", resource: null, containers: [container({})] }],
        metrics: {
            serviceCpu: [
                {
                    machineId: "node",
                    serviceId: "web",
                    container: "web-1",
                    points: [{ time: 60000, value: 120 }],
                },
            ],
            networkOut: [
                {
                    machineId: "node",
                    serviceId: "",
                    container: "",
                    points: [
                        { time: 45000, value: null },
                        { time: 60000, value: 2048 },
                    ],
                },
            ],
            diskWrite: [
                {
                    machineId: "node",
                    serviceId: "",
                    container: "",
                    points: [{ time: 60000, value: 1024 }],
                },
            ],
            disk: [
                {
                    machineId: "node",
                    serviceId: "",
                    container: "",
                    points: [{ time: 60000, value: 50 }],
                },
            ],
            diskTotal: [
                {
                    machineId: "node",
                    serviceId: "",
                    container: "",
                    points: [{ time: 60000, value: 100 }],
                },
            ],
        },
    };

    const machines = machineList([base, { ...base, id: "b" }]);
    expect(machines[0]?.key).not.toBe(machines[1]?.key);
    // Colors follow the name alone, so the same machine name matches across every chart.
    expect(machines[0]?.color).toBe(machines[1]?.color);
    const rows = serviceRows([base, { ...base, id: "b" }]);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(rows[0]).toMatchObject({ cpu: 120, memory: null, memoryPercent: null, networkIn: null });
    expect(percent(rows[0]?.cpu)).toBe("120%");
    expect(percent(0)).toBe("0%");
    expect(percent(null)).toBe("—");
    expect(current(base.metrics.serviceCpu?.[0]?.points, 90, 15)).toBeNull();
    const sent = chartSeries(machines, "networkOut");
    const written = chartSeries(machines, "diskWrite");
    expect(sent[0]?.points.map((point) => point.value)).toEqual([null, 2048]);
    expect(written[0]?.points[0]?.value).toBe(1024);
    expect(sent[0]?.machineKey).toBe(written[0]?.machineKey);
    expect(sent[0]?.machineKey).not.toBe(sent[1]?.machineKey);
    expect(sent[0]?.dashed).toBe(true);
    expect(written[0]?.dashed).toBe(true);
    expect(chartSeries(machines, "networkIn")[0]?.dashed).toBe(false);
    expect(chartSeriesRatio(machines, "disk", "diskTotal")[0]?.points[0]?.value).toBe(50);
});

it("combines a service's containers across machines and keeps each container's own usage", () => {
    const sample = (machineId: string, name: string, value: number) => ({
        machineId,
        serviceId: "web",
        container: name,
        points: [{ time: 60000, value }],
    });

    const cluster: ClusterData = {
        id: "a",
        name: "A",
        available: true,
        start: 0,
        end: 60,
        step: 15,
        unavailable: [],
        machines: [],
        services: [
            {
                id: "web",
                name: "Web",
                resource: null,
                containers: [
                    container({ restarts: 2, memoryLimit: 1000 }),
                    container({
                        id: "c2",
                        name: "web-2",
                        machineId: "other",
                        machineName: "Other",
                        running: false,
                        state: "exited",
                        oomKilled: true,
                        memoryLimit: 1000,
                    }),
                ],
            },
        ],
        metrics: {
            serviceCpu: [sample("node", "web-1", 30), sample("other", "web-2", 20)],
            serviceMemory: [sample("node", "web-1", 400), sample("other", "web-2", 500)],
        },
    };

    const [row] = serviceRows([cluster]);
    expect(row).toMatchObject({
        cpu: 50,
        memory: 900,
        memoryLimit: 2000,
        memoryPercent: 45,
        running: 1,
        restarts: 2,
        oomKilled: 1,
        machines: ["Node", "Other"],
    });
    expect(row?.containers.map((item) => [item.name, item.cpu, item.memoryPercent])).toEqual([
        ["web-1", 30, 40],
        ["web-2", 20, 50],
    ]);

    // The machine filter narrows both the containers and the service totals.
    const [scoped] = serviceRows([cluster], "a:other");
    expect(scoped).toMatchObject({ cpu: 20, memory: 500, containers: [{ name: "web-2" }] });
    expect(serviceRows([cluster], "b:other")).toEqual([]);
    expect(serviceSeries([cluster], [scoped!], ["serviceMemory"], rankMemory)[0]?.points).toEqual([
        { time: 60000, value: 500 },
    ]);
});

it("maps ingress hostnames to per-service HTTP queries", () => {
    expect(
        serviceHosts(
            "App.example.com:8080/https, api.example.com:80/http, 5432:5432/tcp@host, 80/http",
        ),
    ).toEqual(["app.example.com", "api.example.com"]);
    expect(serviceHosts(undefined)).toEqual([]);
    expect(httpQueries("cluster", 15, new Map([["web", []]]))).toBeNull();

    const queries = httpQueries("cluster", 15, new Map([["web", ["app.example.com"]]]));
    expect(queries?.httpRequests.query).toContain(
        'caddy_http_request_duration_seconds_count{customer_id="cluster",host=~"app\\\\.example\\\\.com",handler="subroute"}',
    );
    // One scan grouped by host; services are summed from their hosts afterwards.
    expect(queries?.httpRequests).toMatchObject({ perHost: true });
    expect(queries?.httpRequests.query).toMatch(/^sum by \(host\) /);
    expect(queries?.httpErrors.query).toContain('code=~"5.."');
    expect(queries?.httpLatency).toMatchObject({ perHost: true, quantile: 0.95 });
    expect(queries?.httpLatency.query).toContain("sum by (host, le)");
    expect(queries?.httpLatencyP50.quantile).toBe(0.5);
    expect(queries?.httpLatencyP99.quantile).toBe(0.99);
    expect(queries?.httpStatus.perHost).toBe(false);
});

it("sums each service's hosts and takes quantiles like PromQL", () => {
    // Buckets with 10 requests under 0.1s and 10 more under 1s: the median is the 0.1s bound.
    expect(
        histogramQuantile(0.5, [
            [0.1, 10],
            [1, 20],
            [Infinity, 20],
        ]),
    ).toBeCloseTo(0.1);
    expect(
        histogramQuantile(0.75, [
            [0.1, 10],
            [1, 20],
            [Infinity, 20],
        ]),
    ).toBeCloseTo(0.55);
    // A rank in the +Inf bucket answers with the highest finite bound.
    expect(
        histogramQuantile(0.99, [
            [0.1, 10],
            [Infinity, 20],
        ]),
    ).toBe(0.1);
    expect(
        histogramQuantile(0.5, [
            [0.1, 0],
            [Infinity, 0],
        ]),
    ).toBeNull();

    const hosts = new Map([
        ["web", ["a.example.com", "b.example.com"]],
        ["api", ["api.example.com"]],
        ["idle", ["idle.example.com"]],
    ]);

    const vector = (series: [Record<string, string>, string[]][]) =>
        JSON.stringify({
            status: "success",
            data: {
                resultType: "matrix",
                result: series.map(([metric, values]) => ({
                    metric,
                    values: values.map((value, index) => [index * 15, value]),
                })),
            },
        });

    const sums = parseServiceSeries(
        vector([
            [{ host: "a.example.com" }, ["1", "2"]],
            [{ host: "b.example.com" }, ["3", "NaN"]],
            [{ host: "api.example.com" }, ["5", "6"]],
            [{ host: "other.example.com" }, ["100", "100"]],
        ]),
        0,
        15,
        15,
        hosts,
    );

    expect(sums.map(({ serviceId, values }) => [serviceId, values])).toEqual([
        ["web", [4, 2]],
        ["api", [5, 6]],
    ]);

    // Both hosts' buckets are added up before the quantile, so it covers all of web's requests.
    const [latency] = parseServiceSeries(
        vector([
            [{ host: "a.example.com", le: "0.1" }, ["10"]],
            [{ host: "a.example.com", le: "1" }, ["10"]],
            [{ host: "a.example.com", le: "+Inf" }, ["10"]],
            [{ host: "b.example.com", le: "0.1" }, ["0"]],
            [{ host: "b.example.com", le: "1" }, ["10"]],
            [{ host: "b.example.com", le: "+Inf" }, ["10"]],
        ]),
        0,
        0,
        15,
        new Map([["web", ["a.example.com", "b.example.com"]]]),
        0.75,
    );

    expect(latency?.values[0]).toBeCloseTo(0.55);

    // Latency charts are queried a few hosts at a time; a service is never split across groups.
    const groups = hostGroups(
        new Map([
            ["a", ["1", "2"]],
            ["b", ["3"]],
            ["none", []],
            ["c", ["4", "5", "6"]],
        ]),
        3,
    );

    expect(groups.map((group) => [...group.keys()])).toEqual([["a", "b"], ["c"]]);
});

it("bridges short interior gaps so sparse series still draw", () => {
    const points = (values: (number | null)[], step = 30) =>
        values.map((value, index) => ({ time: index * step * 1000, value }));

    expect(bridgeGaps(points([10, null, 30])).map((point) => point.value)).toEqual([10, 20, 30]);
    expect(bridgeGaps(points([null, 10, null])).map((point) => point.value)).toEqual([
        null,
        10,
        null,
    ]);
    expect(bridgeGaps([])).toEqual([]);

    // A 5.5-minute outage stays a gap instead of drawing a straight line across it.
    const outage = points([10, ...Array<null>(11).fill(null), 30]);
    expect(
        bridgeGaps(outage)
            .slice(1, -1)
            .every((point) => point.value === null),
    ).toBe(true);

    // Alternating samples and single gaps (bursty traffic) connect into one line.
    const bursty = points([12, null, 14, null, 12]);
    expect(bursty.map((point) => point.value)).toEqual([12, null, 14, null, 12]);
    expect(bridgeGaps(bursty).map((point) => point.value)).toEqual([12, 13, 14, 13, 12]);
});

it("assembles per-procedure queries into cluster data, filling charts as metrics arrive", () => {
    const settled = { error: null, isPending: false };
    const window = { start: 0, end: 60, step: 15 };

    const cpu = {
        ...window,
        series: [{ machineId: "node", serviceId: "", container: "", points: [] }],
    };

    const metrics = metricNames.map((name) => {
        if (name === "cpu") return { data: cpu, ...settled };

        if (name === "memory")
            return { data: undefined, error: new Error("down"), isPending: false };

        return { data: undefined, error: null, isPending: true };
    });

    const cluster = assembleCluster(
        { id: "a", name: "A" },
        { data: [{ id: "node", name: "Node", state: "Up" }], ...settled },
        { data: undefined, error: new Error("down"), isPending: false },
        metrics,
    );

    expect(cluster).toMatchObject({
        available: true,
        start: 0,
        end: 60,
        step: 15,
        unavailable: ["Service inventory", "memory"],
        metrics: { cpu: cpu.series },
    });
    expect(cluster.reason).toBeUndefined();

    const loading = assembleCluster(
        { id: "a", name: "A" },
        { data: undefined, error: null, isPending: true },
        { data: undefined, error: null, isPending: true },
        metricNames.map(() => ({ data: undefined, error: null, isPending: true })),
    );

    expect(loading).toMatchObject({ available: false, machines: [], services: [] });
    expect(loading.reason).toBeUndefined();

    const failed = assembleCluster(
        { id: "a", name: "A" },
        { data: [], ...settled },
        { data: [], ...settled },
        metricNames.map(() => ({ data: undefined, error: new Error("down"), isPending: false })),
    );

    expect(failed.reason).toBe("unreachable");

    const uninitialized = assembleCluster(
        { id: "a", name: "A" },
        {
            data: undefined,
            error: new ORPCError("PRECONDITION_FAILED"),
            isPending: false,
        },
        { data: undefined, error: null, isPending: true },
        metricNames.map(() => ({ data: undefined, error: null, isPending: true })),
    );

    expect(uninitialized.reason).toBe("uninitialized");
});

it("detects MySQL metrics from a MySQL or MariaDB server and mysqld-exporter in any services", () => {
    const services = (...images: string[]) =>
        images.map((image, index) => ({
            id: `s${index}`,
            name: `service-${index}`,
            resource: null,
            containers: [container({ image })],
        }));

    expect(hasMysqlExporter(services("mariadb:13.0", "prom/mysqld-exporter:v0.21.0"))).toBe(true);
    expect(hasMysqlExporter(services("mysql:9", "quay.io/prometheus/mysqld-exporter"))).toBe(true);
    expect(hasMysqlExporter(services("mariadb:13.0"))).toBe(false);
    expect(hasMysqlExporter(services("postgres:18", "prom/mysqld-exporter"))).toBe(false);
    expect(services("mariadb:13.0", "prom/mysqld-exporter").map(isMysqlExporter)).toEqual([
        false,
        true,
    ]);
});

it("reports machine usage in cores and bytes, and as a share of capacity", () => {
    const series = (value: number) => ({
        machineId: "node",
        serviceId: "",
        container: "",
        points: [{ time: 60000, value }],
    });

    const cluster: ClusterData = {
        id: "a",
        name: "A",
        available: true,
        start: 0,
        end: 60,
        step: 15,
        machines: [{ id: "node", name: "Node", state: "up" }],
        services: [],
        unavailable: [],
        metrics: {
            cpu: [series(150)],
            cores: [series(4)],
            memory: [series(512)],
            memoryTotal: [series(1024)],
        },
    };

    const usage = machinesUsage(machineList([cluster]));

    expect(usage.cpu).toEqual({ used: 1.5, total: 4, percent: 37.5 });
    expect(usageText(usage.cpu, String, "percent")).toBe("37.5%");
    expect(usageText(usage.memory, (value) => `${value} B`, "absolute")).toBe("512 B / 1024 B");
    // No samples stay unknown rather than reading as 0%.
    expect(usage.disk).toEqual({ used: null, total: null, percent: null });
    expect(usageText(usage.disk, String, "percent")).toBe("—");
});

it("grades usage against each resource's own limits", () => {
    expect(usageLevel("cpu", 64.9)).toBe("normal");
    expect(usageLevel("cpu", 65)).toBe("warning");
    expect(usageLevel("cpu", 90)).toBe("critical");
    expect(usageLevel("memory", 89)).toBe("normal");
    expect(usageLevel("disk", 85)).toBe("warning");
    expect(usageLevel("disk", null)).toBe("normal");
});

it("scales series without turning gaps into zero", () => {
    const [series] = scaleSeries(
        [
            {
                key: "a",
                label: "A",
                color: "red",
                points: [
                    { time: 1, value: 200 },
                    { time: 2, value: null },
                ],
            },
        ],
        0.01,
    );

    expect(series?.points).toEqual([
        { time: 1, value: 2 },
        { time: 2, value: null },
    ]);
});
