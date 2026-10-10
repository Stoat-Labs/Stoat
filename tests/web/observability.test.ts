import { ORPCError } from "@orpc/client";
import {
    hasPostgresExporter,
    httpQueries,
    metricNames,
    parseMetricSeries,
    serviceHosts,
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
    percent,
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

it("detects Postgres metrics from a Postgres server and postgres-exporter in any services", () => {
    const services = (...images: string[]) =>
        images.map((image, index) => ({
            id: `s${index}`,
            name: `service-${index}`,
            href: null,
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
    expect(hasPostgresExporter(services("postgres:18-alpine"))).toBe(false);
    expect(hasPostgresExporter(services("mysql:9", "postgres-exporter"))).toBe(false);
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
        );

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
        services: [{ id: "web", name: "Web", href: null, containers: [container({})] }],
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
                href: null,
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
    expect(queries?.httpRequests).toContain('http_host=~"app\\\\.example\\\\.com"');
    expect(queries?.httpRequests).toContain('"container_label_uncloud_service_id", "web"');
    expect(queries?.httpErrors).toContain('http_status=~"5.."');
    expect(queries?.httpLatency).toContain("histogram_quantile(0.95");
    expect(queries?.httpLatencyP50).toContain("histogram_quantile(0.5");
    expect(queries?.httpLatencyP99).toContain("histogram_quantile(0.99");
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
