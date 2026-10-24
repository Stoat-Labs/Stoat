import { parseEnv } from "node:util";
import {
    CADDY_UPSTREAMS_SERVICE,
    loadsResourceEnv,
    rewriteComposeHostname,
    serviceVariable,
} from "@stoat/workflows/compose";
import { referenceResourceId, VARIABLE_REFERENCE } from "@stoat/workflows/variable-reference";
import YAML, { isAlias, isMap, isScalar, isSeq } from "yaml";
import type { Document, YAMLMap } from "yaml";

// Top-level sections a service can point into by key.
const SHARED_SECTIONS = ["volumes", "configs", "secrets"] as const;

const VARIABLE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/gu;

export type ComposeMove = {
    source: string;
    target: string;
    sourceEnv: string;
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

/**
 * A service as Compose reads it, with anchors and `<<` merge keys expanded. A node's own
 * `toJSON()` can't see the document's anchors, so it would turn `<<: *base` into junk.
 */
function resolved(doc: Document, service: YAMLMap) {
    let value;

    try {
        value = service.toJS(doc);
    } catch (error) {
        // An alias whose anchor a move removed.
        if (error instanceof ReferenceError) throw new ComposeMoveError(BROKEN_ANCHOR);

        throw error;
    }

    // Shared objects would otherwise come back as new `&a1` anchors.
    const node = doc.createNode(value, { aliasDuplicateObjects: false });

    if (!isMap(node)) throw new ComposeMoveError("A service must be a mapping.");

    return node;
}

const BROKEN_ANCHOR =
    "Services left behind use a YAML anchor defined in what moves. Move the anchor into an x- block first.";

/** Throws when an alias in `doc` lost its anchor, which would leave the file unreadable. */
function assertAnchorsKept(doc: Document) {
    const anchors = new Set<string>();
    let dangling = false;

    // Anchors always come before their aliases, so one pass in document order is enough.
    YAML.visit(doc, {
        Alias(_, alias) {
            if (!anchors.has(alias.source)) dangling = true;
        },
        Node(_, node) {
            if (node.anchor) anchors.add(node.anchor);
        },
    });

    if (dangling) throw new ComposeMoveError(BROKEN_ANCHOR);
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

type EnvEntry = { key: string; start: number; end: number };

/**
 * Each `.env` assignment with the lines it spans. Like Node's `parseEnv`, a quoted value runs
 * to its closing quote, across lines when needed.
 */
function envEntries(lines: string[]) {
    const entries: EnvEntry[] = [];

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

        entries.push({ key, start: index, end });
        index = end;
    }

    return entries;
}

/** Raw `.env` assignments for `keys`, so quoting copies exactly. */
function envLines(envText: string, keys: Set<string>) {
    const lines = envText.split("\n");

    return envEntries(lines).flatMap((entry) =>
        keys.has(entry.key) ? lines.slice(entry.start, entry.end + 1) : [],
    );
}

/** `.env` text without the assignments for `keys`. */
function withoutEnvKeys(envText: string, keys: Set<string>) {
    if (keys.size === 0) return envText;

    const lines = envText.split("\n");

    const dropped = new Set(
        envEntries(lines).flatMap((entry) =>
            keys.has(entry.key)
                ? Array.from({ length: entry.end - entry.start + 1 }, (_, at) => entry.start + at)
                : [],
        ),
    );

    return lines.filter((_, index) => !dropped.has(index)).join("\n");
}

/**
 * Rewrites each single-line `.env` value, keeping its quotes and comment. Multiline values
 * and values with escapes are left alone, since they can't be edited in place.
 */
function mapEnvValues(envText: string, rewrite: (value: string) => string) {
    const lines = envText.split("\n");

    for (const entry of envEntries(lines)) {
        const line = lines[entry.start] ?? "";
        const value = parseEnv(line)[entry.key];
        const equals = line.indexOf("=");
        const at = value ? line.indexOf(value, equals + 1) : -1;

        if (entry.start !== entry.end || value === undefined || at === -1) continue;

        const next = rewrite(value);

        if (next !== value)
            lines[entry.start] = `${line.slice(0, at)}${next}${line.slice(at + value.length)}`;
    }

    return lines.join("\n");
}

/** Appends `lines` to `.env` text, ending with a newline. */
function appendEnv(envText: string, lines: string[]) {
    if (lines.length === 0) return envText;

    const base = envText.replace(/\n*$/u, "");

    return `${base}${base ? "\n" : ""}${lines.join("\n")}\n`;
}

/**
 * `keys` plus every variable their values interpolate, transitively. Keys in `supplied` are
 * set elsewhere, so neither they nor what their values here use are followed.
 */
function withDependencies(
    keys: Iterable<string>,
    values: Record<string, string | undefined>,
    supplied = new Set<string>(),
) {
    const needed = new Set<string>();
    const pending = [...keys];

    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
        const value = values[key];

        if (needed.has(key) || supplied.has(key) || value === undefined) continue;

        needed.add(key);

        for (const [, name = ""] of value.matchAll(VARIABLE)) pending.push(name);
    }

    return needed;
}

/** Variables a service interpolates in its Compose. */
function interpolated(service: YAMLMap) {
    return [...JSON.stringify(service.toJSON()).matchAll(VARIABLE)].map((match) => match[1] ?? "");
}

/**
 * Variables a service reads from `values`: the ones it interpolates, or all of them with
 * `env_file: .env` or as its resource's only service (see `inlineEnvFiles`).
 */
function variablesRead(service: YAMLMap, values: Record<string, string | undefined>, only = false) {
    const keys = interpolated(service);

    return only || loadsResourceEnv(service) ? [...keys, ...Object.keys(values)] : keys;
}

// --- Hostnames across resources ---
//
// Inside one Compose file, prefixing renames a service and every bare reference to it (an
// `environment` value, a URL host, an x-caddy upstream). A service in another resource is
// reached through its `<SERVICE>_SERVICE_NAME` built-in instead: Compose interpolates
// `${KEY}`, and Variables hold `KEY={{ <resourceId>.<SERVICE>_SERVICE_NAME }}`. Those references
// are what the canvas draws, and moving services back together turns them into names again.

// Built-ins a service exposes to references, per `systemVariables` in @stoat/workflows.
const SERVICE_BUILTINS = ["SERVICE_NAME", "INTERNAL_HOST", "PUBLIC_DOMAIN"] as const;

const RESOURCE_BUILTINS = [
    "STOAT_PREFIX",
    "STOAT_DOMAIN",
    "STOAT_PROJECT_NAME",
    "STOAT_PROJECT_ID",
    "STOAT_RESOURCE_NAME",
    "STOAT_RESOURCE_ID",
];

const serviceNameKey = (service: string) => `${serviceVariable(service)}_SERVICE_NAME`;

const reference = (resourceId: string, key: string) => `{{ ${resourceId}.${key} }}`;

// Keys set from code are plain strings rather than Scalars.
function serviceNames(services: YAMLMap) {
    return services.items.map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key));
}

/** Keys a resource's Compose sees without any Variables. */
function builtinKeys(names: string[]) {
    return new Set([
        ...RESOURCE_BUILTINS,
        ...names.flatMap((name) =>
            SERVICE_BUILTINS.map((suffix) => `${serviceVariable(name)}_${suffix}`),
        ),
    ]);
}

/** The service owning `key` among `names`: `web-app` and `web_app` share keys, and the first wins. */
function serviceOfKey(names: string[], key: string) {
    const owner = names.find((name) => serviceNameKey(name) === key);

    return owner && names.find((name) => serviceVariable(name) === serviceVariable(owner));
}

/** Throws when another service of the resource owns `service`'s built-ins. */
function assertOwnsBuiltins(names: string[], service: string) {
    const owner = serviceOfKey(names, serviceNameKey(service));

    if (owner !== service)
        throw new ComposeMoveError(
            `"${service}" and "${owner}" share the ${serviceVariable(service)}_* variables, so one can't be referenced from another resource. Rename one of them first.`,
        );
}

/**
 * Rewrites the hostnames `rewrite` handles in a service's `environment` values and x-caddy
 * upstreams: the places prefixing renames services in.
 */
function mapServiceHosts(
    service: YAMLMap,
    rewrite: (value: string) => string,
    upstream: (name: string) => string,
) {
    const environment = service.get("environment", true);

    // Numbers and booleans never name a host, so only changed values are written back.
    if (isSeq(environment))
        for (const item of environment.items) {
            if (!isScalar(item)) continue;

            const text = String(item.value);
            const separator = text.indexOf("=");
            const next = `${text.slice(0, separator + 1)}${rewrite(text.slice(separator + 1))}`;

            if (separator !== -1 && next !== text) item.value = next;
        }
    else if (isMap(environment))
        for (const pair of environment.items) {
            if (!isScalar(pair.value)) continue;

            const text = String(pair.value.value);
            const next = rewrite(text);

            if (next !== text) pair.value.value = next;
        }

    const caddy = service.get("x-caddy", true);

    if (isScalar(caddy))
        caddy.value = String(caddy.value).replace(
            CADDY_UPSTREAMS_SERVICE,
            (_match, open: string, name: string, close: string) =>
                `${open}${upstream(name)}${close}`,
        );
}

/**
 * Variables that link one resource's services to another's, created on first use and reused
 * when the same link already exists. Only hostnames in `linked` are rewritten; `otherNames` is
 * every service of the other resource, for telling whose built-ins a key is.
 */
class Links {
    readonly lines: string[] = [];

    readonly #keys = new Map<string, string>();

    readonly #taken: Set<string>;

    readonly #values: Record<string, string | undefined>;

    constructor(
        envText: string,
        builtins: Set<string>,
        readonly otherId: string,
        readonly otherNames: string[],
        readonly linked: string[],
    ) {
        this.#values = parseEnv(envText);
        this.#taken = new Set([...builtins, ...Object.keys(this.#values)]);
    }

    /** `${KEY}` for a service of the other resource. */
    placeholder(service: string) {
        const known = this.#keys.get(service);

        if (known) return `\${${known}}`;

        const value = this.reference(service);
        const base = serviceNameKey(service);
        let key = base;

        for (let suffix = 2; this.#values[key] !== value && this.#taken.has(key); suffix++)
            key = `${base}_${suffix}`;

        if (this.#values[key] !== value) {
            this.lines.push(`${key}=${value}`);
            this.#taken.add(key);
        }

        this.#keys.set(service, key);

        return `\${${key}}`;
    }

    /** `{{ <otherId>.<SERVICE>_SERVICE_NAME }}` for a service of the other resource. */
    reference(service: string) {
        assertOwnsBuiltins(this.otherNames, service);

        return reference(this.otherId, serviceNameKey(service));
    }

    /** Points every linked hostname in `service` at a placeholder. */
    rewriteService(service: YAMLMap) {
        const others = new Set(this.linked);

        mapServiceHosts(
            service,
            (value) => rewriteComposeHostname(value, others, (name) => this.placeholder(name)),
            (name) => (others.has(name) ? this.placeholder(name) : name),
        );
    }

    /** Points linked hostnames in `.env` values at references. */
    rewriteEnv(envText: string) {
        const others = new Set(this.linked);

        return mapEnvValues(envText, (value) =>
            rewriteComposeHostname(value, others, (name) => this.reference(name)),
        );
    }
}

/** Points references to `service`'s built-ins on `fromId` at `toId`, where it runs now. */
export function retargetServiceReferences(
    envText: string,
    fromId: string,
    toId: string,
    service: string,
) {
    const keys = new Set(SERVICE_BUILTINS.map((suffix) => `${serviceVariable(service)}_${suffix}`));

    return mapEnvValues(envText, (value) =>
        value.replace(VARIABLE_REFERENCE, (match, id: string, key: string) =>
            referenceResourceId(id) === fromId && keys.has(key) ? reference(toId, key) : match,
        ),
    );
}

/** A single reference to a service's name, the shape `Links` writes. */
function linkedService(value: string | undefined) {
    const match = /^\{\{\s*([^\s{}.]+)\.([^\s{}]+)\s*\}\}$/u.exec(value ?? "");
    const id = referenceResourceId(match?.[1] ?? "");

    return id && match?.[2]?.endsWith("_SERVICE_NAME") ? { id, key: match[2] } : undefined;
}

/**
 * Once services share a resource again, its references to itself become plain names, the way
 * the Compose file was written before the split. Link variables that only named one of its own
 * services go, with each `${KEY}` they fed turned back into that name. Edits `doc` in place and
 * returns the new `.env` text.
 */
function collapseSelfReferences(doc: Document, envText: string, resourceId: string) {
    const services = servicesOf(doc, "The Compose file");
    const names = serviceNames(services);
    const values = parseEnv(envText);
    const hosts = new Map<string, string>();

    for (const [key, value] of Object.entries(values)) {
        const link = linkedService(value);
        const service = link?.id === resourceId && serviceOfKey(names, link.key);

        if (service) hosts.set(key, service);
    }

    const desugar = (text: string) =>
        [...hosts].reduce((out, [key, service]) => out.replaceAll(`\${${key}}`, service), text);

    for (const pair of services.items)
        if (isMap(pair.value))
            mapServiceHosts(pair.value, desugar, (name) =>
                name.startsWith("${") ? desugar(name) : name,
            );

    const env = mapEnvValues(envText, (value) =>
        desugar(value).replace(VARIABLE_REFERENCE, (match, id: string, key: string) => {
            if (referenceResourceId(id) !== resourceId) return match;

            return serviceOfKey(names, key) ?? `\${${key}}`;
        }),
    );

    // A key still read somewhere else, like a `command`, stays with the plain name.
    const serviceMaps = services.items.flatMap((pair) =>
        isMap(pair.value) ? [resolved(doc, pair.value)] : [],
    );

    const envValues = parseEnv(env);

    const used = withDependencies(
        serviceMaps.flatMap((service) => variablesRead(service, envValues)),
        envValues,
    );

    return withoutEnvKeys(env, new Set([...hosts.keys()].filter((key) => !used.has(key))));
}

/** Link variables no service of the resource reads any more. */
function unusedLinks(services: YAMLMap[], envText: string) {
    const values = parseEnv(envText);

    const used = withDependencies(
        services.flatMap((service) => variablesRead(service, values)),
        values,
    );

    return new Set(
        Object.keys(values).filter((key) => !used.has(key) && linkedService(values[key])),
    );
}

/**
 * Moves one service from the source Compose file into the target, editing YAML nodes so
 * comments elsewhere survive. Named volumes keep their data by pinning the real Docker volume
 * name (the source resource's prefixed name), since Uncloud passes `volumes.*.name` through.
 * Hostnames that now cross resources become references (see "Hostnames across resources").
 */
export function moveComposeService(options: {
    service: string;
    source: string;
    target: string;
    sourceId: string;
    targetId: string;
    sourcePrefix: string | undefined;
    sourceEnv: string;
    targetEnv: string;
}): ComposeMove {
    const { service: name, sourceId, targetId, sourcePrefix } = options;
    const sourceDoc = YAML.parseDocument(options.source, { merge: true });
    const targetDoc = YAML.parseDocument(options.target, { merge: true });

    if (sourceDoc.errors.length || targetDoc.errors.length)
        throw new ComposeMoveError("Fix the Compose YAML errors before moving services.");

    const sourceServices = servicesOf(sourceDoc, "The source Compose file");

    // An empty target is a resource being created for this service, so it starts its own services.
    const targetServices = options.target.trim()
        ? servicesOf(targetDoc, "The target Compose file")
        : sectionOf(targetDoc, "services");

    const node = sourceServices.get(name, true);

    if (!isMap(node)) throw new ComposeMoveError(`Service "${name}" was not found.`);

    // The moved service leaves its anchors behind, so it travels expanded.
    const service = resolved(sourceDoc, node);

    if (targetServices.has(name))
        throw new ComposeMoveError(`The target already has a service named "${name}".`);

    const warnings: string[] = [];

    const remaining = sourceServices.items.flatMap((pair) =>
        isScalar(pair.key) && pair.key.value !== name && isMap(pair.value) ? [pair.value] : [],
    );

    const remainingNames = serviceNames(sourceServices).filter((other) => other !== name);

    // `remaining` is edited in place below, so its expanded form is read fresh each time.
    const remainingResolved = () => remaining.map((other) => resolved(sourceDoc, other));

    // Copy shared definitions the service uses; keep them in the source while others still do.
    for (const section of SHARED_SECTIONS) {
        const sourceEntries = sourceDoc.get(section, true);

        for (const key of new Set(sectionKeys(service, section))) {
            const entry = isMap(sourceEntries) ? sourceEntries.get(key, true) : undefined;
            const definition = isAlias(entry) ? entry.resolve(sourceDoc) : entry;
            const targetEntries = sectionOf(targetDoc, section);

            if (targetEntries.has(key))
                throw new ComposeMoveError(
                    `The target already defines ${section.slice(0, -1)} "${key}".`,
                );

            const copied = isMap(definition)
                ? resolved(sourceDoc, definition)
                : targetDoc.createNode({});

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

            const stillUsed = remainingResolved().some((other) =>
                sectionKeys(other, section).includes(key),
            );

            if (!stillUsed && isMap(sourceEntries)) sourceEntries.delete(key);

            if (section === "configs" && isMap(definition) && definition.has("file"))
                warnings.push(`Config "${key}" reads a file; make sure the target can reach it.`);
        }
    }

    const moved = targetDoc.createNode(service.toJSON());

    if (!isMap(moved)) throw new ComposeMoveError(`Service "${name}" was not found.`);

    for (const dependency of dependsOn(moved)) {
        if (targetServices.has(dependency)) continue;

        dropDependency(moved, dependency);
        warnings.push(`"${name}" no longer waits for "${dependency}", which stays behind.`);
    }

    const existingTargetServices = targetServices.items.flatMap((pair) =>
        isMap(pair.value) ? [resolved(targetDoc, pair.value)] : [],
    );

    // A resource's only service gets every Variable without `env_file: .env`, so moves change that.
    const [onlyTarget] = existingTargetServices;
    const [onlySource] = remainingResolved();

    if (existingTargetServices.length === 1 && onlyTarget && !loadsResourceEnv(onlyTarget))
        warnings.push(
            `"${serviceNames(targetServices)[0]}" is no longer the target's only service, so it only gets the Variables it references.`,
        );

    if (existingTargetServices.length && remaining.length === 0 && !loadsResourceEnv(service))
        warnings.push(
            `"${name}" is no longer its resource's only service, so it only gets the Variables it references.`,
        );

    if (remaining.length === 1 && onlySource && !loadsResourceEnv(onlySource))
        warnings.push(
            `"${remainingNames[0]}" is now the source's only service, so it gets all of its Variables.`,
        );

    targetServices.set(name, moved);
    sourceServices.delete(name);
    assertAnchorsKept(sourceDoc);

    const targetNames = serviceNames(targetServices);

    // Sections the move emptied would linger as `volumes: {}`.
    for (const section of SHARED_SECTIONS) {
        const entries = sourceDoc.get(section, true);

        if (isMap(entries) && entries.items.length === 0) sourceDoc.delete(section);
    }

    const remainingNow = remainingResolved();

    for (const [index, other] of remaining.entries()) {
        if (!dependsOn(other).includes(name)) {
            // Editing a shared anchor would change every service using it, so the user decides.
            if (remainingNow[index] && dependsOn(remainingNow[index]).includes(name))
                throw new ComposeMoveError(
                    `"${remainingNames[index]}" waits for "${name}" through a YAML anchor. Remove it there first.`,
                );

            continue;
        }

        dropDependency(other, name);
        warnings.push(`A service left behind no longer waits for "${name}".`);
    }

    // References anywhere in either file to the service where it was now point where it is.
    const sourceEnv = retargetServiceReferences(options.sourceEnv, sourceId, targetId, name);
    const targetEnv = retargetServiceReferences(options.targetEnv, sourceId, targetId, name);

    // Variables the service reads follow it, with the ones their values use, unless the
    // target already sets them. They are read before the source's values are rewritten.
    const sourceValues = parseEnv(sourceEnv);
    const targetKeys = new Set(Object.keys(parseEnv(targetEnv)));

    const needed = withDependencies(
        variablesRead(service, sourceValues, remaining.length === 0),
        sourceValues,
        targetKeys,
    );

    const copiedLines = envLines(sourceEnv, needed);

    // Services already in the target that read a copied key would change with it.
    const shared = [...needed].filter((key) =>
        existingTargetServices.some(
            (other) => loadsResourceEnv(other) || interpolated(other).includes(key),
        ),
    );

    if (shared.length)
        warnings.push(
            `"${name}" brings ${shared.map((key) => `\${${key}}`).join(", ")}, which services already in the target read too.`,
        );

    // What stays behind reaches the moved service through the target, and only that service:
    // a target service sharing a name with one left behind is a different service.
    const toTarget = new Links(sourceEnv, builtinKeys(remainingNames), targetId, targetNames, [
        name,
    ]);

    for (const other of remaining) toTarget.rewriteService(other);

    const sourceUsed = withDependencies(
        remainingResolved().flatMap((other) => variablesRead(other, sourceValues)),
        sourceValues,
    );

    const rewrittenSource = rewriteUsedEnv(sourceEnv, sourceUsed, (line) =>
        toTarget.rewriteEnv(line),
    );

    // The moved service reaches what stays behind through the source.
    const toSource = new Links(
        appendEnv(targetEnv, copiedLines),
        builtinKeys(targetNames),
        sourceId,
        remainingNames,
        remainingNames,
    );

    toSource.rewriteService(moved);

    const copied = copiedLines.length
        ? toSource.rewriteEnv(copiedLines.join("\n")).split("\n")
        : [];

    const nextSource = appendEnv(rewrittenSource, toTarget.lines);
    const nextTarget = appendEnv(appendEnv(targetEnv, copied), toSource.lines);

    // Both edit their document, so they run before it is printed.
    const collapsedSource = collapseSelfReferences(sourceDoc, nextSource, sourceId);
    const collapsedTarget = collapseSelfReferences(targetDoc, nextTarget, targetId);

    return {
        source: sourceDoc.toString(),
        target: targetDoc.toString(),
        // Links only the moved service used stay behind otherwise, and the canvas would draw them.
        sourceEnv: withoutEnvKeys(
            collapsedSource,
            unusedLinks(remainingResolved(), collapsedSource),
        ),
        targetEnv: collapsedTarget,
        sourceEmpty: remaining.length === 0,
        warnings,
    };
}

/** Rewrites only the `.env` values whose keys are in `keys`, leaving the rest byte-identical. */
function rewriteUsedEnv(envText: string, keys: Set<string>, rewrite: (text: string) => string) {
    const lines = envText.split("\n");

    for (const entry of envEntries(lines))
        if (keys.has(entry.key) && entry.start === entry.end)
            lines[entry.start] = rewrite(lines[entry.start] ?? "");

    return lines.join("\n");
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
