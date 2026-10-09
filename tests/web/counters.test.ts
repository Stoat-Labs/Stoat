import type { MetricPoint } from "../../packages/api/src/observability";
import { expect, it } from "vite-plus/test";
import type { MachineData } from "../../apps/web/src/lib/observability";
import {
    counterCount,
    counterPercent,
    counterTotal,
} from "../../apps/web/src/lib/observability/counters";

function machine(id: string, points: MetricPoint[]): MachineData {
    return {
        key: id,
        id,
        name: id,
        color: "var(--chart-1)",
        cluster: {
            id: "cluster",
            name: "Cluster",
            available: true,
            start: 0,
            end: 120,
            step: 60,
            machines: [{ id, name: id, state: "Up" }],
            services: [],
            metrics: {},
            unavailable: [],
            totals: { dnsQueries: [{ machineId: id, serviceId: "", container: "", points }] },
        },
    };
}

it("sums the latest sample of every machine", () => {
    const machines = [
        machine("a", [
            { time: 0, value: 1 },
            { time: 60, value: 10 },
        ]),
        machine("b", [{ time: 60, value: 5 }]),
    ];

    expect(counterTotal(machines, "dnsQueries")).toBe(15);
});

it("never presents a partial total when a machine has not reported", () => {
    const machines = [
        machine("a", [{ time: 60, value: 10 }]),
        machine("b", [
            { time: 0, value: 4 },
            { time: 60, value: null },
        ]),
    ];

    const silent = [machine("a", []), machine("b", [{ time: 60, value: 1 }])];

    expect(counterTotal(machines, "dnsQueries")).toBeNull();
    expect(counterTotal(silent, "dnsQueries")).toBeNull();
    expect(counterTotal([], "dnsQueries")).toBeNull();
});

it("only computes a percentage over a known, non-zero denominator", () => {
    expect(counterPercent(5, 20)).toBe(25);
    expect(counterPercent(0, 0)).toBeNull();
    expect(counterPercent(null, 20)).toBeNull();
    expect(counterPercent(5, null)).toBeNull();
});

it("shows a dash instead of zero for unknown counts", () => {
    expect(counterCount(null)).toBe("—");
    expect(counterCount(0)).toBe("0");
});
