/**
 * Caddyfile edits for HTTP metrics. Dependency-free, so the Caddy settings dialog can check the
 * Caddyfile as it is edited.
 */

/** The `metrics` subdirectives HTTP traffic needs: hostnames map metrics to services, OTLP pushes them to Alloy. */
export const REQUIRED_METRICS_SUBDIRECTIVES = ["per_host", "otlp"];

const METRICS_OPTION = ["\tmetrics {", "\t\tper_host", "\t\totlp", "\t}"];

type MetricsOption = { start: number; end: number; indent: string; subdirectives: string[] };

/** A line without its quoted text and trailing comment, so neither counts as braces. */
function code(line: string) {
    return line
        .replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""')
        .replace(/(^|\s)#.*$/, "")
        .trim();
}

function braceDelta(line: string) {
    const text = code(line);

    return (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
}

function indentation(line: string) {
    return line.slice(0, line.length - line.trimStart().length);
}

/** The global options block's opening line, or -1. Caddy only accepts it as the first thing in the file. */
function globalBlockStart(lines: string[]) {
    const start = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));

    return start !== -1 && lines[start]!.trim() === "{" ? start : -1;
}

/** Reads `metrics`, `metrics { per_host }` or a multi-line `metrics { … }` starting at `start`. */
function readMetricsOption(lines: string[], start: number): MetricsOption | null {
    const line = code(lines[start]!);
    const indent = indentation(lines[start]!);

    if (!line.includes("{")) return { start, end: start, indent, subdirectives: [] };

    if (line.endsWith("}")) {
        const inner = line.slice(line.indexOf("{") + 1, -1).trim();

        return { start, end: start, indent, subdirectives: inner ? inner.split(/\s+/) : [] };
    }

    const subdirectives: string[] = [];
    let depth = 1;

    for (let index = start + 1; index < lines.length; index++) {
        const inner = code(lines[index]!);

        if (inner === "") continue;

        if (depth === 1 && inner !== "}") subdirectives.push(inner.split(/\s+/)[0]!);

        depth += braceDelta(inner);

        if (depth === 0) return { start, end: index, indent, subdirectives };
    }

    return null;
}

function findMetricsOption(lines: string[]): MetricsOption | null {
    const start = globalBlockStart(lines);

    if (start === -1) return null;

    let depth = 0;

    for (let index = start; index < lines.length; index++) {
        const line = lines[index]!.trim();

        if (line.startsWith("#")) continue;

        if (depth === 1 && /^metrics(\s|\{|$)/.test(line)) return readMetricsOption(lines, index);

        depth += braceDelta(line);

        if (depth === 0) break;
    }

    return null;
}

/**
 * Turns on per-host HTTP metrics with OTLP export in the global options block, creating the
 * block when there is none. A `metrics` option the user already wrote is left alone; see
 * missingMetricsSubdirectives.
 */
export function withCaddyMetrics(caddyfile: string): string {
    const lines = caddyfile.trim().split("\n");
    const start = globalBlockStart(lines);

    if (start === -1) {
        const block = ["{", ...METRICS_OPTION, "}"].join("\n");

        return caddyfile.trim() ? `${block}\n\n${caddyfile.trim()}\n` : `${block}\n`;
    }

    if (findMetricsOption(lines)) return caddyfile;

    lines.splice(start + 1, 0, ...METRICS_OPTION);

    return `${lines.join("\n")}\n`;
}

/**
 * Subdirectives a user-written global `metrics` option lacks for HTTP traffic. Empty when the
 * option is complete or absent, since Stoat adds a complete one itself when it is absent.
 */
export function missingMetricsSubdirectives(caddyfile: string): string[] {
    const option = findMetricsOption(caddyfile.split("\n"));

    if (!option) return [];

    return REQUIRED_METRICS_SUBDIRECTIVES.filter((name) => !option.subdirectives.includes(name));
}

/** Adds the missing subdirectives to the user's global `metrics` option, keeping the rest of it. */
export function completeMetricsOption(caddyfile: string): string {
    const lines = caddyfile.split("\n");
    const option = findMetricsOption(lines);

    if (!option) return caddyfile;

    const missing = REQUIRED_METRICS_SUBDIRECTIVES.filter(
        (name) => !option.subdirectives.includes(name),
    );

    if (!missing.length) return caddyfile;

    // A multi-line block keeps its own lines, comments included; the others are rebuilt.
    const multiline = option.end > option.start;
    const body = multiline ? lines.slice(option.start + 1, option.end) : [];
    const firstChild = body.find((line) => line.trim() !== "");

    const childIndent = firstChild
        ? indentation(firstChild)
        : option.indent + (option.indent || "\t");

    const children = multiline ? body : option.subdirectives.map((name) => `${childIndent}${name}`);

    lines.splice(
        option.start,
        option.end - option.start + 1,
        `${option.indent}metrics {`,
        ...children,
        ...missing.map((name) => `${childIndent}${name}`),
        `${option.indent}}`,
    );

    return lines.join("\n");
}
