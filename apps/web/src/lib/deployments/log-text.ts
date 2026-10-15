import type { LogRow } from "$lib/resources/logs";

/** Plain-text form of deployment log rows, for copying and downloading. */
export function logsAsText(rows: LogRow[]) {
    return rows
        .map(
            (row) =>
                `${row.timestamp} ${(row.label ?? (row.level === "error" ? "error" : "info")).toUpperCase().padEnd(5)} ${row.message}`,
        )
        .join("\n");
}
