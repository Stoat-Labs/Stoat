/**
 * Row-level edits on a `.env` file that leave every other line untouched, so comments, blank lines,
 * quoting and `export` prefixes survive editing one variable. Parsing follows Node's `parseEnv`,
 * which the server deploys with: the last assignment of a key wins.
 */

export type EnvVariable = {
    key: string;
    value: string;
    /** First and last line of the assignment; quoted values may span lines. */
    start: number;
    end: number;
};

const assignment = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/u;

const quotes = new Set(['"', "'", "`"]);

function unquote(raw: string, lines: string[], index: number) {
    const quote = raw[0];

    // Unquoted values end at the first `#`, even without a space before it.
    if (!quote || !quotes.has(quote))
        return { value: (raw.split("#")[0] ?? "").trim(), end: index };

    let text = raw.slice(1);

    let end = index;

    // A quoted value continues onto later lines until its closing quote.
    while (!text.includes(quote) && end + 1 < lines.length) {
        end += 1;
        text += `\n${lines[end]}`;
    }

    const close = text.indexOf(quote);

    // Without a closing quote anywhere, the quote is part of a plain one-line value.
    if (close === -1) return { value: raw.trim(), end: index };

    const value = text.slice(0, close);

    return { value: quote === '"' ? value.replaceAll("\\n", "\n") : value, end };
}

/** The variables Node's `parseEnv` would read, last assignment winning, in file order. */
export function parseEnvLines(text: string) {
    const variables = new Map<string, EnvVariable>();

    for (const entry of parseAllAssignments(text)) {
        variables.delete(entry.key);
        variables.set(entry.key, entry);
    }

    return [...variables.values()].toSorted((left, right) => left.start - right.start);
}

/** Writes a value so `parseEnv` reads it back unchanged, or throws when no quoting can. */
export function formatEnvValue(value: string) {
    if (/^[^\s#"'`\\]*$/u.test(value)) return value;

    if (!value.includes('"') && !value.includes("\\n")) return `"${value.replaceAll("\n", "\\n")}"`;

    if (!value.includes("'")) return `'${value}'`;

    if (!value.includes("`")) return `\`${value}\``;

    throw new Error("This value mixes \", ' and ` quotes in a way a .env file can't store.");
}

function withoutLines(text: string, ranges: { start: number; end: number }[]) {
    const drop = new Set(
        ranges.flatMap(({ start, end }) =>
            Array.from({ length: end - start + 1 }, (_, i) => start + i),
        ),
    );

    return text
        .split("\n")
        .filter((_, index) => !drop.has(index))
        .join("\n");
}

/** Sets `key`, replacing its last assignment in place, or appending it. Earlier duplicates are dropped. */
export function setEnvVariable(text: string, key: string, value: string, previousKey = key) {
    const line = `${key}=${formatEnvValue(value)}`;

    const all = parseAllAssignments(text);

    const own = all.filter((entry) => entry.key === previousKey);

    const last = own.at(-1);

    // A rename must not leave a second assignment of the new key behind.
    const stale = all.filter(
        (entry) => entry !== last && (entry.key === previousKey || entry.key === key),
    );

    if (!last) {
        const kept = withoutLines(text, stale);

        const base = kept.length && !kept.endsWith("\n") ? `${kept}\n` : kept;

        return `${base}${line}\n`;
    }

    const lines = text.split("\n");

    lines.splice(last.start, last.end - last.start + 1, line);

    // Line numbers past the replaced range shifted; recompute before dropping duplicates.
    const updated = lines.join("\n");

    const remaining = parseAllAssignments(updated).filter(
        (entry) => (entry.key === previousKey || entry.key === key) && entry.start !== last.start,
    );

    return withoutLines(updated, remaining);
}

export function removeEnvVariable(text: string, key: string) {
    return withoutLines(
        text,
        parseAllAssignments(text).filter((entry) => entry.key === key),
    );
}

/** Every assignment in order, duplicates included. */
function parseAllAssignments(text: string) {
    const lines = text.split("\n");

    const entries: EnvVariable[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const match = assignment.exec(lines[index] ?? "");

        if (!match?.[1]) continue;

        const { value, end } = unquote(match[2] ?? "", lines, index);

        entries.push({ key: match[1], value, start: index, end });
        index = end;
    }

    return entries;
}
