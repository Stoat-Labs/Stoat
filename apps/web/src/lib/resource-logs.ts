import type { ResourceLog } from "@stoat/api/routers/resources/logs";
import { z } from "zod";

export type LogLevel = "error" | "warning" | "success" | "other";

export type DisplayLog = ResourceLog & { id: number; level: LogLevel; time: number };

/** Minimal row shape rendered by the shared log viewer. */
export type LogRow = {
    id: number;
    key: string;
    time: number;
    timestamp: string;
    level: LogLevel;
    message: string;
    label?: string;
    muted?: boolean;
};

export type LogBucket = { index: number; domainStart: number; domainEnd: number };

export function logEntryKey(log: ResourceLog) {
    const source = JSON.stringify([
        log.timestamp,
        log.serviceId,
        log.machine,
        log.container,
        log.stream,
        log.message,
    ]);

    let first = 0x811c9dc5;
    let second = 0x9e3779b9;

    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
    }

    return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

export function selectedLogServices(
    services: { id: string; name: string }[],
    names: string[] | null,
) {
    return names === null
        ? services.slice(0, 20)
        : services.filter((service) => names.includes(service.name));
}

const statusCode = z.union([z.number(), z.string()]).optional().catch(undefined);

const structuredLog = z.object({
    level: z.union([z.string(), z.number()]).optional().catch(undefined),
    severity: z.string().optional().catch(undefined),
    severity_text: z.string().optional().catch(undefined),
    status: statusCode,
    statusCode,
    res: z.object({ statusCode }).optional().catch(undefined),
    http: z
        .object({
            status_code: statusCode,
            response: z.object({ status_code: statusCode }).optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
});

const logTimestamp = String.raw`(?:\[[\d:.TZ +/-]+\]|\d{4}-\d{2}-\d{2}[T ]\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)`;

const logLevelWord = String.raw`(?:error|err|fatal|panic|crit(?:ical)?|warn(?:ing)?|notice|note|info|debug|trace|success|ok)`;

const logLevelPrefix = new RegExp(
    String.raw`^(?:${logTimestamp}\s+)?(?:\d+\s+)?\[?(error|fatal|panic|warn(?:ing)?|success|ok)\]?(?=[\s:|-]|$)`,
    "iu",
);

const logPrefix = new RegExp(
    String.raw`^(?:${logTimestamp}(?:\s+(?:\d+\s+)?\[?${logLevelWord}\]?(?=[\s:|-]|$))?|(?:\d+\s+)?\[${logLevelWord}\])[\s:|-]*`,
    "iu",
);

/** Removes a leading timestamp, thread ID and level already shown in their own columns. */
export function stripLogPrefix(message: string) {
    return message.replace(logPrefix, "");
}

export function classifyLog(message: string): LogLevel {
    let level: string | number | undefined;
    let status = Number.NaN;

    try {
        const entry = structuredLog.safeParse(JSON.parse(message)).data;
        level = entry?.level ?? entry?.severity ?? entry?.severity_text;
        status = Number(
            entry?.statusCode ??
                entry?.res?.statusCode ??
                entry?.http?.response?.status_code ??
                entry?.http?.status_code ??
                entry?.status,
        );

        if (level === undefined && entry?.status === "success") level = "success";
    } catch {
        // Allow a timestamp and numeric thread ID before an explicit level (e.g. MariaDB).
        level = logLevelPrefix.exec(message.trim())?.[1];
    }

    if (
        level === "50" ||
        level === "60" ||
        level === 50 ||
        level === 60 ||
        /^(error|fatal|panic)$/iu.test(String(level))
    )
        return "error";

    if (level === "40" || level === 40 || /^warn(ing)?$/iu.test(String(level))) return "warning";

    if (Number.isInteger(status) && status >= 400 && status <= 599) return "error";

    if (/^(success|ok)$/iu.test(String(level))) return "success";

    if (Number.isInteger(status) && status >= 200 && status <= 299) return "success";

    return "other";
}

export function logBucketIndex(time: number, start: number, end: number) {
    if (!Number.isFinite(time) || time < start || time > end) return -1;

    return Math.min(23, Math.floor((time - start) / (Math.max(1, end - start) / 24)));
}

export function logActivity(logs: Pick<LogRow, "time" | "level">[], start: number, end: number) {
    const width = Math.max(1, end - start) / 24;
    const counts = { error: 0, warning: 0, success: 0, other: 0 };

    const buckets = Array.from({ length: 24 }, (_, index) => ({
        start: start + index * width,
        end: start + (index + 1) * width,
        error: 0,
        warning: 0,
        success: 0,
        other: 0,
        total: 0,
    }));

    for (const log of logs) {
        const index = logBucketIndex(log.time, start, end);

        if (index < 0) continue;
        const bucket = buckets[index]!;
        bucket[log.level]++;
        bucket.total++;
        counts[log.level]++;
    }

    return { buckets, counts, maximum: Math.max(1, ...buckets.map((bucket) => bucket.total)) };
}
