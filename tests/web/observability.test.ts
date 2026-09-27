import { ORPCError } from "@orpc/client";
import { metricNames } from "../../packages/api/src/observability";
import { expect, it } from "vite-plus/test";
import {
    assembleCluster,
    chartSeries,
    chartSeriesRatio,
    current,
    machineList,
    percent,
    serviceRows,
    type ClusterData,
} from "../../apps/web/src/lib/observability";

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
        services: [
            {
                id: "web",
                name: "Web",
                machineId: "node",
                machineName: "Node",
                running: 1,
                containers: 1,
                href: null,
            },
        ],
        metrics: {
            serviceCpu: [
                { machineId: "node", serviceId: "web", points: [{ time: 60000, value: 120 }] },
            ],
            networkOut: [
                {
                    machineId: "node",
                    serviceId: "",
                    points: [
                        { time: 45000, value: null },
                        { time: 60000, value: 2048 },
                    ],
                },
            ],
            diskWrite: [
                { machineId: "node", serviceId: "", points: [{ time: 60000, value: 1024 }] },
            ],
            disk: [
                { machineId: "node", serviceId: "", points: [{ time: 60000, value: 50 }] },
            ],
            diskTotal: [
                { machineId: "node", serviceId: "", points: [{ time: 60000, value: 100 }] },
            ],
        },
    };

    const machines = machineList([base, { ...base, id: "b" }]);
    expect(machines[0]?.key).not.toBe(machines[1]?.key);
    expect(machines[0]?.color).not.toBe(machines[1]?.color);
    const rows = serviceRows([base, { ...base, id: "b" }]);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
    expect(rows[0]).toMatchObject({ cpu: 120, memory: null, memoryPercent: null, networkIn: null });
    expect(percent(rows[0]?.cpu)).toBe("120%");
    expect(percent(0)).toBe("0%");
    expect(percent(null)).toBe("—");
    expect(current(base.metrics.serviceCpu?.[0], 90, 15)).toBeNull();
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

it("assembles per-procedure queries into cluster data, filling charts as metrics arrive", () => {
    const settled = { error: null, isPending: false };
    const window = { start: 0, end: 60, step: 15 };
    const cpu = { ...window, series: [{ machineId: "node", serviceId: "", points: [] }] };

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
