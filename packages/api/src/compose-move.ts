import { parseEnv } from "node:util";
import YAML, { isMap, isScalar, isSeq } from "yaml";
import type { Document, YAMLMap } from "yaml";

// Top-level sections a service can point into by key.
const SHARED_SECTIONS = ["volumes", "configs", "secrets"] as const;

const VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu;

export type ComposeMove = {
    source: string;
    target: string;
    targetEnv: string;
    /** No services left: the caller removes the source resource instead of saving it. */
    sourceEmpty: boolean;
    warnings: string[];
};

export class ComposeMoveError extends Error {}

function servicesOf(doc: Document, label: string) {
    const services = doc.get("services", true);

    if (!isMap(services)) throw new ComposeMoveError(`${label} has no services.`);

    return services;
}

function sectionOf(doc: Document, section: string) {
    const entries = doc.get(section, true);

    if (isMap(entries)) return entries;

    const created = doc.createNode({});

    doc.set(section, created);

    return created;
}

/** Keys a service uses from `volumes`, `configs` or `secrets`, in either Compose syntax. */
function sectionKeys(service: YAMLMap, section: (typeof SHARED_SECTIONS)[number]) {
    const entries = service.get(section, true);

    if (!isSeq(entries)) return [];

    return entries.items.flatMap((item) => {
        if (isScalar(item)) {
            const text = String(item.value);

            // Volumes are `source:target`; a single segment is an anonymous volume.
            if (section !== "volumes") return [text];

            const [source = ""] = text.split(":");

            return text.includes(":") && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(source)
                ? [source]
                : [];
        }

        if (!isMap(item)) return [];

        const source = item.get("source", true);
        const type = item.get("type", true);
        const isVolume = !isScalar(type) || type.value === "volume";

        return isScalar(source) && (section !== "volumes" || isVolume)
            ? [String(source.value)]
            : [];
    });
}

function dependsOn(service: YAMLMap) {
    const entries = service.get("depends_on", true);

    if (isSeq(entries))
        return entries.items.map((item) => String(isScalar(item) ? item.value : item));

    return isMap(entries)
        ? entries.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key))
        : [];
}

function dropDependency(service: YAMLMap, name: string) {
    const entries = service.get("depends_on", true);

    if (isSeq(entries)) {
        entries.items = entries.items.filter((item) => !(isScalar(item) && item.value === name));
    } else if (isMap(entries)) {
        entries.delete(name);
    }

    if ((isSeq(entries) || isMap(entries)) && entries.items.length === 0)
        service.delete("depends_on");
}

/**
 * Raw `.env` assignments for `keys`, so quoting copies exactly. Like Node's `parseEnv`, a quoted
 * value runs to its closing quote, across lines when needed.
 */
function envLines(envText: string, keys: Set<string>) {
    const lines = envText.split("\n");
    const copied: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/u.exec(lines[index] ?? "");

        if (!match) continue;

        const [, key = "", value = ""] = match;
        const quote = value[0];
        let end = index;

        if (quote === '"' || quote === "'" || quote === "`") {
            const closing = lines.findIndex((line, at) =>
                at > index ? line.includes(quote) : at === index && value.slice(1).includes(quote),
            );

            if (closing !== -1) end = closing;
        }

        if (keys.has(key)) copied.push(...lines.slice(index, end + 1));

        index = end;
    }

    return copied;
}

/** `keys` plus every source variable their values interpolate, transitively. */
function withDependencies(keys: Iterable<string>, values: Record<string, string | undefined>) {
    const needed = new Set<string>();
    const pending = [...keys];

    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
        const value = values[key];

        if (needed.has(key) || value === undefined) continue;

        needed.add(key);

        for (const [, name = ""] of value.matchAll(VARIABLE)) pending.push(name);
    }

    return needed;
}

/**
 * Moves one service from the source Compose file into the target, editing YAML nodes so
 * comments elsewhere survive. Named volumes keep their data by pinning the real Docker volume
 * name (the source resource's prefixed name), since Uncloud passes `volumes.*.name` through.
 */
export function moveComposeService(options: {
    service: string;
    source: string;
    target: string;
    sourcePrefix: string | undefined;
    sourceEnv: string;
    targetEnv: string;
}): ComposeMove {
    const { service: name, sourcePrefix } = options;
    const sourceDoc = YAML.parseDocument(options.source);
    const targetDoc = YAML.parseDocument(options.target);

    if (sourceDoc.errors.length || targetDoc.errors.length)
        throw new ComposeMoveError("Fix the Compose YAML errors before moving services.");

    const sourceServices = servicesOf(sourceDoc, "The source Compose file");

    // An empty target is a resource being created for this service, so it starts its own services.
    const targetServices = options.target.trim()
        ? servicesOf(targetDoc, "The target Compose file")
        : sectionOf(targetDoc, "services");

    const service = sourceServices.get(name, true);

    if (!isMap(service)) throw new ComposeMoveError(`Service "${name}" was not found.`);

    if (targetServices.has(name))
        throw new ComposeMoveError(`The target already has a service named "${name}".`);

    const warnings: string[] = [];

    const remaining = sourceServices.items.flatMap((pair) =>
        isScalar(pair.key) && pair.key.value !== name && isMap(pair.value) ? [pair.value] : [],
    );

    // Copy shared definitions the service uses; keep them in the source while others still do.
    for (const section of SHARED_SECTIONS) {
        const sourceEntries = sourceDoc.get(section, true);

        for (const key of new Set(sectionKeys(service, section))) {
            const definition = isMap(sourceEntries) ? sourceEntries.get(key, true) : undefined;
            const targetEntries = sectionOf(targetDoc, section);

            if (targetEntries.has(key))
                throw new ComposeMoveError(
                    `The target already defines ${section.slice(0, -1)} "${key}".`,
                );

            const copied = targetDoc.createNode(isMap(definition) ? definition.toJSON() : {});

            targetEntries.set(key, copied);

            if (
                section === "volumes" &&
                isMap(copied) &&
                !copied.has("name") &&
                copied.get("external") !== true
            )
                targetDoc.setIn(
                    [section, key, "name"],
                    sourcePrefix ? `${sourcePrefix}-${key}` : key,
                );

            const stillUsed = remaining.some((other) => sectionKeys(other, section).includes(key));

            if (!stillUsed && isMap(sourceEntries)) sourceEntries.delete(key);

            if (section === "configs" && isMap(definition) && definition.has("file"))
                warnings.push(`Config "${key}" reads a file; make sure the target can reach it.`);
        }
    }

    const moved = targetDoc.createNode(service.toJSON());

    if (isMap(moved)) {
        for (const dependency of dependsOn(moved)) {
            if (targetServices.has(dependency)) continue;

            dropDependency(moved, dependency);
            warnings.push(`"${name}" no longer waits for "${dependency}", which stays behind.`);
        }
    }

    targetServices.set(name, moved);
    sourceServices.delete(name);

    // Sections the move emptied would linger as `volumes: {}`.
    for (const section of SHARED_SECTIONS) {
        const entries = sourceDoc.get(section, true);

        if (isMap(entries) && entries.items.length === 0) sourceDoc.delete(section);
    }

    for (const other of remaining) {
        if (!dependsOn(other).includes(name)) continue;

        dropDependency(other, name);
        warnings.push(`A service left behind no longer waits for "${name}".`);
    }

    // Variables the service interpolates follow it, with the ones their values use, unless the
    // target already sets them.
    const used = [...JSON.stringify(service.toJSON()).matchAll(VARIABLE)].map(
        (match) => match[1] ?? "",
    );

    const targetKeys = new Set(Object.keys(parseEnv(options.targetEnv)));
    const needed = withDependencies(used, parseEnv(options.sourceEnv));
    const missing = new Set([...needed].filter((key) => !targetKeys.has(key)));
    const copiedLines = envLines(options.sourceEnv, missing);

    const targetEnv = copiedLines.length
        ? `${options.targetEnv.replace(/\n*$/u, "")}${options.targetEnv.trim() ? "\n" : ""}${copiedLines.join("\n")}\n`
        : options.targetEnv;

    return {
        source: sourceDoc.toString(),
        target: targetDoc.toString(),
        targetEnv,
        sourceEmpty: remaining.length === 0,
        warnings,
    };
}

/**
 * Drops the Docker volume names moves pin, so a copy's volumes get its own names instead of
 * opening the original's data. External volumes keep their names; they are shared on purpose.
 */
export function unpinVolumeNames(compose: string) {
    const doc = YAML.parseDocument(compose);
    const volumes = doc.get("volumes", true);

    if (doc.errors.length || !isMap(volumes)) return compose;

    const pinned = volumes.items.flatMap(({ value }) =>
        isMap(value) && value.has("name") && value.get("external") !== true ? [value] : [],
    );

    for (const volume of pinned) volume.delete("name");

    // Untouched files keep their exact text.
    return pinned.length ? doc.toString() : compose;
}
