import { posix } from "node:path";
import * as v from "valibot";
import YAML, { isMap, isScalar, isSeq, Scalar } from "yaml";
import type { Document, Node, YAMLMap, YAMLSeq } from "yaml";

import { NAMED_VOLUME } from "./compose-volumes";

export class ComposeConfigError extends Error {}

// `merge` resolves `<<: *anchor`, which is how the copyparty-style stacks share their configs.
const parse = (compose: string) => {
    const doc = YAML.parseDocument(compose, { merge: true });

    if (doc.errors.length) throw new ComposeConfigError("Fix the Compose YAML errors first.");

    return doc;
};

function serviceNode(doc: Document, name: string) {
    const services = doc.get("services", true);
    const service = isMap(services) ? services.get(name, true) : undefined;

    if (!isMap(service)) throw new ComposeConfigError(`Service "${name}" was not found.`);

    return service;
}

function declared(doc: Document) {
    const configs = doc.get("configs", true);

    return isMap(configs) ? configs : undefined;
}

/**
 * The service's own `configs` list. One it inherits through an alias or a `<<` merge is shared
 * with every service using the anchor, so it is copied onto this service before an edit.
 */
function ownMounts(doc: Document, service: YAMLMap, create: boolean) {
    const configs = service.get("configs", true);

    // SAFETY: Compose config mounts are scalars (short syntax) or maps (long syntax).
    const own = isSeq(configs) ? (configs as YAMLSeq<Node | null>) : undefined;

    if (own) return own;

    const inherited: unknown = service.toJS(doc).configs;

    if (!Array.isArray(inherited) && !create) return undefined;

    const copy = doc.createNode(Array.isArray(inherited) ? inherited : []);

    service.set("configs", copy);

    return copy;
}

/**
 * Drops a service's emptied `configs` list. It stays, empty, while it overrides an inherited one
 * (or the inherited mounts come back) or is anchored (or the aliases of it would dangle).
 */
function pruneMounts(doc: Document, service: YAMLMap, mounts: YAMLSeq<Node | null>) {
    if (mounts.items.length > 0 || mounts.anchor) return;

    service.delete("configs");

    const inherited: unknown = service.toJS(doc).configs;

    if (inherited !== undefined) service.set("configs", mounts);
}

function mountSource(item: Node | null) {
    if (isScalar(item)) return String(item.value);

    const source = isMap(item) ? item.get("source", true) : undefined;

    return isScalar(source) ? String(source.value) : undefined;
}

function checkTarget(target: string) {
    if (!target.startsWith("/") || /\s/u.test(target))
        throw new ComposeConfigError("The mount path must be absolute, like /etc/app.conf.");
}

// compose-go reads a string mode as octal; a bare YAML number would be taken as decimal.
function checkMode(mode: string) {
    if (!/^0?[0-7]{3}$/u.test(mode))
        throw new ComposeConfigError("The mode is three octal digits, like 0444.");
}

function mount(doc: Document, config: string, service: string, target: string) {
    checkTarget(target);

    const mounts = ownMounts(doc, serviceNode(doc, service), true);

    if (mounts?.items.some((item) => mountSource(item) === config))
        throw new ComposeConfigError(`"${service}" already mounts "${config}".`);

    // Long syntax with a target: Uncloud's default `/<source>` would see the deploy's prefixed name.
    mounts?.add(doc.createNode({ source: config, target }));
}

/** Declares a new config with empty inline content and mounts it into a service. */
export function addConfig(compose: string, config: string, service: string, target: string) {
    if (!NAMED_VOLUME.test(config))
        throw new ComposeConfigError(
            "Config names use letters, digits, dots, hyphens and underscores.",
        );

    const doc = parse(compose);

    if (declared(doc)?.has(config))
        throw new ComposeConfigError(`A config named "${config}" already exists.`);

    mount(doc, config, service, target);

    if (!declared(doc)) doc.set("configs", doc.createNode({}));

    declared(doc)?.set(config, doc.createNode({ content: "" }));

    return String(doc);
}

/** Mounts a config the Compose file already declares into another service. */
export function attachConfig(compose: string, config: string, service: string, target: string) {
    const doc = parse(compose);

    if (!declared(doc)?.has(config))
        throw new ComposeConfigError(`There is no config named "${config}".`);

    mount(doc, config, service, target);

    return String(doc);
}

/** Unmounts a config from one service; it stays declared, as a card of its own. */
export function detachConfig(compose: string, config: string, service: string) {
    const doc = parse(compose);
    const node = serviceNode(doc, service);
    const mounts = ownMounts(doc, node, false);

    if (!mounts?.items.some((item) => mountSource(item) === config))
        throw new ComposeConfigError(`"${service}" does not mount "${config}".`);

    mounts.items = mounts.items.filter((item) => mountSource(item) !== config);
    pruneMounts(doc, node, mounts);

    return String(doc);
}

/** Moves a service's mount of a config to another path and mode; an empty mode drops it. */
export function updateConfigMount(
    compose: string,
    config: string,
    service: string,
    target: string,
    mode: string,
) {
    checkTarget(target);

    if (mode) checkMode(mode);

    const doc = parse(compose);
    const mounts = ownMounts(doc, serviceNode(doc, service), false);
    const index = mounts?.items.findIndex((item) => mountSource(item) === config) ?? -1;
    const item = mounts?.items[index];

    if (!mounts || !item) throw new ComposeConfigError(`"${service}" does not mount "${config}".`);

    // Short syntax becomes long syntax, keeping any uid, gid or mode it already had.
    const entry = isMap(item) ? item : doc.createNode({ source: config });

    entry.set("target", target);

    if (mode) {
        // Quoted, so no YAML reader takes it as a decimal or octal number.
        const scalar = doc.createNode(mode.padStart(4, "0"));

        scalar.type = Scalar.QUOTE_DOUBLE;
        entry.set("mode", scalar);
    } else entry.delete("mode");

    mounts.items[index] = entry;

    return String(doc);
}

/** Replaces a config's inline content, as a literal block. */
export function setConfigContent(compose: string, config: string, content: string) {
    const doc = parse(compose);
    const node = declared(doc)?.get(config, true);

    if (!isMap(node)) throw new ComposeConfigError(`There is no config named "${config}".`);

    if (node.has("file") || node.has("environment"))
        throw new ComposeConfigError(`"${config}" is not an inline config.`);

    const scalar = doc.createNode(content);

    scalar.type = Scalar.BLOCK_LITERAL;
    node.set("content", scalar);

    return String(doc);
}

/** Deletes a config from the Compose file, unmounting it from every service first. */
export function removeConfig(compose: string, config: string) {
    const doc = parse(compose);
    const configs = declared(doc);

    if (!configs?.has(config))
        throw new ComposeConfigError(`There is no config named "${config}".`);

    const services = doc.get("services", true);

    for (const { value } of isMap(services) ? services.items : []) {
        const mounts = isMap(value) ? ownMounts(doc, value, false) : undefined;

        if (!isMap(value) || !mounts) continue;

        mounts.items = mounts.items.filter((item) => mountSource(item) !== config);
        pruneMounts(doc, value, mounts);
    }

    configs.delete(config);

    if (configs.items.length === 0) doc.delete("configs");

    return String(doc);
}

/** Named after the file it mounts as, numbered when taken: `/etc/nginx/nginx.conf` is `nginx.conf`. */
export function nextConfigName(compose: string, target: string) {
    const names = declared(parse(compose));

    const base =
        posix
            .basename(target)
            .replaceAll(/[^a-zA-Z0-9_.-]/gu, "-")
            .replace(/^[._-]+/u, "") || "config";

    for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base}-${n}`;

        if (!names?.has(name)) return name;
    }
}

const mountSchema = v.union([
    v.pipe(
        v.string(),
        v.transform((source) => ({ source, target: `/${source}`, mode: null })),
    ),
    v.pipe(
        v.object({
            source: v.string(),
            target: v.optional(v.string()),
            // A YAML number is shown in octal as compose-go applies it: decimal, so `mode: 444` is 0674.
            mode: v.optional(
                v.union([
                    v.string(),
                    v.pipe(
                        v.number(),
                        v.transform((mode) => `0${mode.toString(8)}`),
                    ),
                ]),
            ),
        }),
        v.transform(({ source, target, mode }) => ({
            source,
            target: target ?? `/${source}`,
            mode: mode ?? null,
        })),
    ),
]);

const configsSchema = v.object({
    services: v.record(
        v.string(),
        v.nullish(v.object({ configs: v.nullish(v.array(mountSchema)) })),
    ),
    configs: v.nullish(
        v.record(
            v.string(),
            v.nullish(
                v.object({
                    content: v.optional(v.string()),
                    file: v.optional(v.string()),
                    environment: v.optional(v.string()),
                }),
            ),
        ),
    ),
});

export type GraphConfig = {
    name: string;
    /** Inline content; null for a `file:` or `environment:` config. */
    content: string | null;
    /** The path a `file:` config reads, as written. */
    file: string | null;
    /** Services that mount it; none once they are disconnected, but it stays declared. */
    services: string[];
    mounts: { service: string; target: string; mode: string | null }[];
};

/** Declared configs and where each service mounts them, following `<<` merges. */
export function composeConfigs(compose: string): GraphConfig[] {
    const { services, configs } = v.parse(configsSchema, YAML.parse(compose, { merge: true }));

    const found = new Map<string, GraphConfig>(
        Object.entries(configs ?? {}).map(([name, config]) => [
            name,
            {
                name,
                // Only inline content is edited here; `file` and `environment` configs have none.
                content:
                    config?.file === undefined && config?.environment === undefined
                        ? (config?.content ?? "")
                        : null,
                file: config?.file ?? null,
                services: [],
                mounts: [],
            },
        ]),
    );

    for (const [service, entry] of Object.entries(services))
        for (const { source, target, mode } of entry?.configs ?? []) {
            // Mounting an undeclared config is a Compose error; it shows up once declared.
            const config = found.get(source);

            if (!config) continue;

            if (!config.services.includes(service)) config.services.push(service);
            config.mounts.push({ service, target, mode });
        }

    return [...found.values()];
}
