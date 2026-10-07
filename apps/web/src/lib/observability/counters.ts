import type { MachineMetricName } from "@stoat/api/observability";
import { metricTotals, type MachineData } from "$lib/observability";

/** Require every visible machine to report; never present a partial total as complete. */
export function counterTotal(machines: MachineData[], name: MachineMetricName) {
    let total = 0;

    if (!machines.length) return null;

    for (const machine of machines) {
        const points = metricTotals(machine.cluster, name, machine.id);
        const value = points.at(-1)?.value ?? null;

        if (value === null) return null;
        total += value;

        continue;
    }

    return total;
}

export function counterPercent(numerator: number | null, denominator: number | null) {
    return numerator !== null && denominator !== null && denominator > 0
        ? (100 * numerator) / denominator
        : null;
}

export function counterCount(value: number | null) {
    return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
