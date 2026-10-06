import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusterMonitoring, clusters, projects, resources } from "@stoat/db/schema/index";
import { encryptMonitoringPassword } from "@stoat/workflows/secrets";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { assembleCluster } from "../../apps/web/src/lib/observability";
import {
    metricNames,
    parseMetricSeries,
    type MetricName,
    type ObservabilityRange,
} from "../../packages/api/src/observability";
import { observabilityRouter } from "../../packages/api/src/routers/cluster/observability";
import { metricsRouter } from "../../packages/api/src/routers/cluster/metrics";

const exec = promisify(execFile);

const nativeFetch = globalThis.fetch;

const clusterId = randomUUID();

const projectId = randomUUID();

const resourceId = randomUUID();

const organizationId = randomUUID();

const databaseName = `observability_${randomUUID().replaceAll("-", "")}`;

const secret = "observability-test-secret-at-least-32-characters";

const end = Math.floor(Date.now() / 1000 / 15) * 15;

let admin: ReturnType<typeof createDb>;

let db: ReturnType<typeof createDb>;

let context: Context;

let container = "";

let greptimeUrl = "";

async function sql(query: string) {
    const response = await nativeFetch(`${greptimeUrl}/v1/sql?db=public`, {
        method: "POST",
        body: new URLSearchParams({ sql: query }),
    });

    const result = await response.json();
    expect(result.error).toBeUndefined();

    return result;
}

beforeAll(async () => {
    admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
    await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    db = createDb({ DATABASE_URL: url.toString() });
    await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
    await db.$client.query(
        `INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Metrics',$1,now())`,
        [organizationId],
    );
    context = { db, session: null, apiKey: { id: "test-key", organizationId } };
    await db.insert(clusters).values({
        id: clusterId,
        organizationId,
        name: "Metrics",
        sidecarUrl: "http://metrics.test",
        sidecarToken: "private",
        initializedAt: new Date(),
    });
    await db.insert(projects).values({ id: projectId, clusterId, name: "App" });
    await db.insert(resources).values({
        id: resourceId,
        projectId,
        name: "Web",
        spec: "services:\n  web:\n    image: nginx\n",
        settings: { prefixNames: false },
    });
    await db.insert(clusterMonitoring).values({
        clusterId,
        projectId,
        resourceId,
        encryptedPassword: encryptMonitoringPassword("password", secret, clusterId),
    });
    container = (
        await exec("docker", [
            "run",
            "--rm",
            "-d",
            "-p",
            "127.0.0.1::4000",
            "greptime/greptimedb:v1.2.1",
            "standalone",
            "start",
            "--http-addr",
            "0.0.0.0:4000",
        ])
    ).stdout.trim();
    greptimeUrl = `http://${(await exec("docker", ["port", container, "4000"])).stdout.trim()}`;
    await vi.waitFor(
        async () => expect((await nativeFetch(`${greptimeUrl}/health`)).ok).toBe(true),
        { timeout: 20000, interval: 100 },
    );
    await sql("CREATE DATABASE monitoring");

    const gauges = new Map([
        ["node_memory_MemTotal_bytes", 1024],
        ["node_memory_MemAvailable_bytes", 256],
        ["node_filesystem_size_bytes", 100],
        ["node_filesystem_avail_bytes", 20],
        ["container_memory_working_set_bytes", 128],
    ]);

    const counters = [
        "node_cpu_seconds_total",
        "node_network_receive_bytes_total",
        "node_network_transmit_bytes_total",
        "node_disk_read_bytes_total",
        "node_disk_written_bytes_total",
        "container_cpu_usage_seconds_total",
        "container_network_receive_bytes_total",
        "container_network_transmit_bytes_total",
    ];

    for (const name of [...gauges.keys(), ...counters]) {
        await sql(
            `CREATE TABLE monitoring."${name}" (customer_id STRING, machine_id STRING, cpu STRING, "mode" STRING, device STRING, mountpoint STRING, fstype STRING, container_label_uncloud_service_id STRING, "name" STRING, greptime_value DOUBLE, greptime_timestamp TIMESTAMP TIME INDEX, PRIMARY KEY(customer_id,machine_id,cpu,"mode",device,mountpoint,fstype,container_label_uncloud_service_id,"name"))`,
        );
        const values: string[] = [];

        for (let index = 0; index <= 8; index++) {
            const timestamp = new Date((end - 120 + index * 15) * 1000).toISOString();

            const add = (
                value: number,
                cpu = "",
                mode = "",
                device = "eth0",
                mountpoint = "/",
                fstype = "ext4",
            ) =>
                values.push(
                    `('${clusterId}','machine-1','${cpu}','${mode}','${device}','${mountpoint}','${fstype}','${name.startsWith("container") ? "web-id" : ""}','${name.startsWith("container") ? "web-1" : ""}',${value},'${timestamp}')`,
                );

            if (name === "node_cpu_seconds_total") {
                for (const cpu of ["0", "1"]) {
                    add(index * 12, cpu, "idle");
                    add(index * 3, cpu, "user");
                    add(index * 2, cpu, "guest");
                }
            } else if (name.startsWith("node_filesystem")) {
                add(gauges.get(name)!, "", "", "/dev/vda1");

                for (const mount of ["/data", "/data-bind"])
                    add(name.endsWith("size_bytes") ? 200 : 10, "", "", "/dev/vdb1", mount, "xfs");
                add(name.endsWith("size_bytes") ? 1000 : 0, "", "", "tmpfs", "/run", "tmpfs");
                add(name.endsWith("size_bytes") ? 500 : 10, "", "", "/dev/vda2", "/boot", "ext4");
                add(
                    name.endsWith("size_bytes") ? 100 : 5,
                    "",
                    "",
                    "/dev/vda3",
                    "/boot/efi",
                    "vfat",
                );
            } else if (gauges.has(name)) add(gauges.get(name)!);
            else if (name === "container_cpu_usage_seconds_total") add(index * 18);
            else {
                add(index * 15000);

                if (name.startsWith("node_network")) add(index * 15000000, "", "", "veth-test");
            }
        }

        await sql(`INSERT INTO monitoring."${name}" VALUES ${values.join(",")}`);
    }

    await sql(
        `CREATE TABLE monitoring.loki_process_custom_http_requests_total (customer_id STRING, http_host STRING, http_status STRING, greptime_value DOUBLE, greptime_timestamp TIMESTAMP TIME INDEX, PRIMARY KEY(customer_id,http_host,http_status))`,
    );
    await sql(
        `CREATE TABLE monitoring.loki_process_custom_http_request_duration_seconds_bucket (customer_id STRING, http_host STRING, http_status STRING, le STRING, greptime_value DOUBLE, greptime_timestamp TIMESTAMP TIME INDEX, PRIMARY KEY(customer_id,http_host,http_status,le))`,
    );
    const requests: string[] = [];
    const buckets: string[] = [];

    for (let index = 0; index <= 8; index++) {
        const timestamp = new Date((end - 120 + index * 15) * 1000).toISOString();

        // 1.5 req/s of 200s and 0.5 req/s of 500s; other hosts must not be counted.
        for (const [host, status, rate] of [
            ["app.example.com", "200", 1.5],
            ["app.example.com", "500", 0.5],
            ["other.example.com", "200", 100],
        ] as const) {
            requests.push(
                `('${clusterId}','${host}','${status}',${index * 15 * rate},'${timestamp}')`,
            );

            for (const [le, share] of [
                ["0.1", 0.5],
                ["1", 1],
                ["+Inf", 1],
            ] as const)
                buckets.push(
                    `('${clusterId}','${host}','${status}','${le}',${index * 15 * rate * share},'${timestamp}')`,
                );
        }
    }

    await sql(
        `INSERT INTO monitoring.loki_process_custom_http_requests_total VALUES ${requests.join(",")}`,
    );
    await sql(
        `INSERT INTO monitoring.loki_process_custom_http_request_duration_seconds_bucket VALUES ${buckets.join(",")}`,
    );
}, 60000);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

afterAll(async () => {
    if (container) await exec("docker", ["rm", "-f", container]);
    await db?.$client.end();

    if (admin) {
        await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await admin.$client.end();
    }
});

it("queries real GreptimeDB through the private transport, showing percent CPU and scoped service placements", async () => {
    vi.stubEnv("APP_SECRET", secret);
    vi.spyOn(Date, "now").mockReturnValue(end * 1000);

    const fetch = vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(String(request));
        expect(url.origin).toBe("http://metrics.test");
        expect(new Headers(options?.headers).get("authorization")).toBe("Bearer private");

        if (url.pathname.endsWith("/exec")) {
            const body = JSON.parse(String(options?.body));
            const command: string[] = body.command;
            expect(command.slice(0, 8)).toEqual([
                "curl",
                "--silent",
                "--show-error",
                "--fail-with-body",
                "--max-time",
                "15",
                "--config",
                "-",
            ]);
            expect(body.stdin).toBe('user = "stoat:password"\n');
            const parameters = new URLSearchParams();

            for (let index = 8; index < command.length - 1; index += 2) {
                expect(command[index]).toBe("--data-urlencode");
                const argument = command[index + 1]!;
                const separator = argument.indexOf("=");
                parameters.set(argument.slice(0, separator), argument.slice(separator + 1));
            }

            const target = new URL(command.at(-1)!);

            if (target.pathname.includes("prometheus"))
                expect(parameters.get("query")).toContain(`customer_id="${clusterId}"`);

            const response = await nativeFetch(`${greptimeUrl}${target.pathname}${target.search}`, {
                method: "POST",
                body: parameters,
            });

            return Response.json({
                exitCode: response.ok ? 0 : 22,
                truncated: false,
                stdout: await response.text(),
            });
        }

        if (url.pathname.endsWith("/machines"))
            return Response.json({ items: [{ id: "machine-1", name: "Node", state: "Up" }] });

        if (url.pathname.endsWith("/services"))
            return Response.json({
                items: [
                    {
                        id: "web-id",
                        name: "web",
                        mode: "replicated",
                        containers: [
                            {
                                machineId: "machine-1",
                                machineName: "Node",
                                container: {
                                    Id: "abc",
                                    Name: "/web-1",
                                    RestartCount: 3,
                                    State: { Running: true, Status: "running", OOMKilled: false },
                                    HostConfig: { Memory: 512, NanoCpus: 500000000 },
                                    Config: {
                                        Labels: {
                                            "uncloud.service.ports": "app.example.com:80/http",
                                        },
                                    },
                                },
                            },
                        ],
                        hookContainers: [],
                    },
                ],
            });

        return Response.json({ id: "metrics", containers: [{ container: { Id: "container" } }] });
    });

    vi.stubGlobal("fetch", fetch);

    const range = { from: end - 900, to: end };

    const metric = (name: MetricName, range: ObservabilityRange, ctx = context) =>
        call(
            observabilityRouter.getObservabilityMetric,
            { clusterId, name, range },
            { context: ctx },
        );

    const [machines, services, ...metrics] = await Promise.all([
        call(observabilityRouter.getObservabilityMachines, { clusterId }, { context }),
        call(observabilityRouter.getObservabilityServices, { clusterId }, { context }),
        ...metricNames.map((name) => metric(name, range)),
    ]);

    const result = assembleCluster(
        { id: clusterId, name: "Metrics" },
        { data: machines, error: null, isPending: false },
        { data: services, error: null, isPending: false },
        metrics.map((data) => ({ data, error: null, isPending: false })),
    );

    expect(result.available).toBe(true);
    expect(result.unavailable).toEqual([]);
    expect(result.machines).toEqual([{ id: "machine-1", name: "Node", state: "Up" }]);
    expect(result.metrics.cpu?.[0]?.points.at(-1)?.value).toBeCloseTo(40);
    expect(result.metrics.serviceCpu?.[0]?.points.at(-1)?.value).toBeCloseTo(120);
    expect(result.metrics.memory?.[0]?.points.at(-1)?.value).toBe(768);
    expect(result.metrics.disk?.[0]?.points.at(-1)?.value).toBe(270);
    expect(result.metrics.diskTotal?.[0]?.points.at(-1)?.value).toBe(300);
    expect(result.metrics.filesystemTotal).toHaveLength(3);
    expect(
        result.metrics.filesystemTotal?.some((series) => series.mountpoint?.startsWith("/boot")),
    ).toBe(false);
    expect(
        result.metrics.filesystemUsed?.find((series) => series.mountpoint === "/data"),
    ).toMatchObject({
        device: "/dev/vdb1",
        fstype: "xfs",
        points: expect.arrayContaining([{ time: end * 1000, value: 190 }]),
    });
    expect(result.metrics.networkIn?.[0]?.points.at(-1)?.value).toBeCloseTo(1000);
    expect(result.step).toBe(15);
    expect(result.end).toBe(end);
    expect(result.metrics.cpu?.[0]?.points).toHaveLength(61);

    for (const name of ["disk", "diskTotal"] as const) {
        expect(result.metrics[name]?.[0]?.points).toHaveLength(61);
        expect(
            result.metrics[name]?.[0]?.points.slice(-9).every((point) => point.value !== null),
        ).toBe(true);
    }

    expect(result.metrics.serviceCpu?.[0]?.points.length).toBeLessThanOrEqual(25);
    expect(result.metrics.serviceCpu?.[0]?.container).toBe("web-1");
    expect(result.services).toMatchObject([
        {
            id: "web-id",
            href: `/projects/${projectId}/${resourceId}`,
            containers: [
                {
                    id: "abc",
                    name: "web-1",
                    machineName: "Node",
                    running: true,
                    restarts: 3,
                    oomKilled: false,
                    memoryLimit: 512,
                    cpuLimit: 0.5,
                },
            ],
        },
    ]);
    expect(JSON.stringify(result)).not.toContain("password");
    const execs = fetch.mock.calls.filter(([request]) => String(request).endsWith("/exec"));
    expect(execs).toHaveLength(metricNames.length);
    const uncached = fetch.mock.calls.length;
    await expect(metric("cpu", range)).resolves.toEqual(metrics[0]);
    expect(fetch.mock.calls).toHaveLength(uncached);

    await expect(
        call(metricsRouter.getClusterMetrics, { clusterId }, { context }),
    ).resolves.toMatchObject({
        available: true,
        machines: 1,
        disk: { used: 270, total: 300 },
    });

    const week = await metric("cpu", "7d");
    expect(week.end - week.start).toBeGreaterThanOrEqual(604800);
    expect(week.series[0]?.points.length).toBeLessThanOrEqual(121);
    // Stale-while-revalidate: the next window serves the previous one while a refresh runs.
    vi.spyOn(Date, "now").mockReturnValue((end + 15) * 1000);
    await expect(metric("cpu", "7d")).resolves.toEqual(week);
    await vi.waitFor(async () => expect((await metric("cpu", "7d")).end).toBe(end + 15));
    await expect(metric("cpu", { from: end, to: end + 30 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
    });

    const scoped = (serviceIds: string[]) =>
        call(
            observabilityRouter.getObservabilityMetric,
            { clusterId, name: "serviceMemory", range, serviceIds },
            { context },
        );

    // Scoped requests chart the whole window instead of the table's latest-only sample.
    expect((await scoped(["web-id"])).series[0]?.points).toHaveLength(61);
    await expect(scoped(["other-id"])).resolves.toMatchObject({ series: [] });
    await expect(scoped(['web-id"}) or vector(1'])).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const before = fetch.mock.calls.length;
    await expect(
        metric("cpu", "1h", { ...context, apiKey: { id: "other", organizationId: randomUUID() } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetch.mock.calls).toHaveLength(before);

    const http = (
        name: "httpRequests" | "httpErrors" | "httpLatency" | "httpLatencyP50" | "httpLatencyP99",
        serviceIds = ["web-id"],
    ) =>
        call(
            observabilityRouter.getObservabilityMetric,
            { clusterId, name, range, serviceIds },
            { context },
        );

    // Alloy's Caddy access-log counters are recorded per host; the query maps them back to the service.
    const requests = await http("httpRequests");
    expect(requests.status).toBe("ok");
    expect(requests.series[0]).toMatchObject({ serviceId: "web-id" });
    expect(requests.series[0]?.points.at(-1)?.value).toBeCloseTo(2);
    expect((await http("httpErrors")).series[0]?.points.at(-1)?.value).toBeCloseTo(0.5);
    expect((await http("httpLatency")).series[0]?.points.at(-1)?.value).toBeGreaterThan(0);
    const p50 = (await http("httpLatencyP50")).series[0]?.points.at(-1)?.value;
    const p95 = (await http("httpLatency")).series[0]?.points.at(-1)?.value;
    const p99 = (await http("httpLatencyP99")).series[0]?.points.at(-1)?.value;
    expect(p50).toBeGreaterThan(0);
    expect(p99).toBeGreaterThan(0);
    expect(Number(p50)).toBeLessThanOrEqual(Number(p95));
    expect(Number(p95)).toBeLessThanOrEqual(Number(p99));
    await expect(http("httpRequests", ["other-id"])).resolves.toMatchObject({
        status: "no-routes",
        series: [],
    });
}, 60000);

it("preserves missing, NaN and stale samples as gaps rather than inventing zeros", () => {
    const series = parseMetricSeries(
        JSON.stringify({
            status: "success",
            data: {
                resultType: "matrix",
                result: [
                    {
                        metric: { machine_id: "node" },
                        values: [
                            [0, "120"],
                            [30, "NaN"],
                            [45, "+Inf"],
                        ],
                    },
                ],
            },
        }),
        0,
        60,
        15,
    );

    expect(series[0]?.points.map((point) => point.value)).toEqual([120, null, null, null, null]);
    expect(() => parseMetricSeries('{"status":"error"}', 0, 60, 15)).toThrow();
});
