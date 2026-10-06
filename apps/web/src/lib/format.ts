const relative = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
    style: "short",
});

export function ago(value: Date | string, now: number) {
    const seconds = Math.round((new Date(value).getTime() - now) / 1000);

    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 31_536_000],
        ["month", 2_592_000],
        ["week", 604_800],
        ["day", 86_400],
        ["hour", 3_600],
        ["minute", 60],
    ];

    for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    }

    return "just now";
}

/** h/m/s duration shared by the deployment table and viewer. */
export function formatDurationMs(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function deploymentDuration(
    createdAt: Date | string,
    finishedAt: Date | string | null,
    now = Date.now(),
) {
    const end = finishedAt ? new Date(finishedAt).getTime() : now;

    return formatDurationMs(end - new Date(createdAt).getTime());
}

export function formatDate(value: Date | string) {
    return new Date(value).toLocaleDateString();
}

/** Elapsed m:ss since `from`, for live progress rows. */
export function elapsed(from: Date | string, now: number) {
    const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Millisecond-precision clock time for log lines and activity bars. */
export function logTime(value: string | number) {
    return new Date(value).toLocaleString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
        hour12: false,
    });
}

/** Full date + time for search range summaries. */
export function logDateTime(value: string | number) {
    return new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
    });
}

/** datetime-local value (local timezone) for date inputs. */
export function toLocalDateInput(value: Date) {
    return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 19);
}

/** Display value for a stored ISO date, or "" when invalid. */
export function parseDateInput(value: string) {
    const time = Date.parse(value);

    return Number.isFinite(time) ? toLocalDateInput(new Date(time)) : "";
}
