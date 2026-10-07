import { createChartCursor, type ChartCursorController } from "@tanstack/charts/cursor";
import { getContext, setContext } from "svelte";

const key = Symbol("metric-chart-cursor");

/** Links the hover cursor of every MetricChart rendered below the caller, matched by timestamp. */
export function syncMetricCharts() {
    setContext(key, createChartCursor<number, number>());
}

export function metricChartCursor() {
    return getContext<ChartCursorController<number, number> | undefined>(key);
}
