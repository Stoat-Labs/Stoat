// Ported from stoat-old's src/lib/server/deployments/deployment-compose.ts:
// only the formatting/prefixing core, shared by previews and deployment workers.

import YAML, { isAlias, isMap, isNode, isScalar, isSeq, YAMLMap } from "yaml";
import type { Node } from "yaml";
import { Predicate } from "effect";
import { posix } from "node:path";
import { parseEnv } from "node:util";
import { parseAllAssignments } from "./env-lines";
import { parseIngressComposeWith } from "./ingress";
import { referenceResourceId, VARIABLE_REFERENCE } from "./variable-reference";

export interface FormattedCompose {
    serviceCount: number;
    serviceNames: string[];
    yaml: string;
}

/**
 * Deployment prefix for a resource compose spec: its stored slug, e.g. `seafile-k3f9x2-web`.
 * Unique, so Uncloud treats each resource's services and volumes as distinct, and fixed, so
 * renames and moves keep them. Returns undefined when the resource opted out via
 * `settings.prefixNames === false`.
 */
export function resourceComposePrefix(resource: {
    slug: string;
    settings: unknown;
}): string | undefined {
    if (Predicate.isObject(resource.settings) && resource.settings.prefixNames === false) {
        return undefined;
    }

    return resource.slug;
}

/** The `<SERVICE>` part of a service's built-in variables, like `WEB_APP` for `web-app`. */
export const serviceVariable = (name: string): string =>
    name.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");

const prefixName = (name: string, prefix?: string): string => {
    if (!prefix) {
        return name;
    }

    return `${prefix}-${name}`;
};

/** Uncloud's cluster DNS name for a Compose service, reachable from every other service. */
export const internalHostname = (name: string, prefix?: string): string =>
    `${prefixName(name, prefix)}.internal`;

const isNamedVolumeSource = (source: string): boolean => {
    if (source === "") {
        return false;
    }

    if (
        source.startsWith("/") ||
        source.startsWith("./") ||
        source.startsWith("../") ||
        source.startsWith("~")
    ) {
        return false;
    }

    return !/^[A-Za-z]:[\\/]/u.test(source);
};

type Rename = (name: string) => string;

const prefixShortVolumeSpec = (spec: string, rename: Rename): string => {
    const separatorIndex = spec.indexOf(":");

    if (separatorIndex <= 0) {
        return spec;
    }

    const source = spec.slice(0, separatorIndex);

    if (!isNamedVolumeSource(source)) {
        return spec;
    }

    return `${rename(source)}${spec.slice(separatorIndex)}`;
};

const prefixVolumeMount = (node: Node, rename: Rename): void => {
    if (isScalar(node) && Predicate.isString(node.value)) {
        node.value = prefixShortVolumeSpec(node.value, rename);

        return;
    }

    if (!isMap(node)) {
        return;
    }

    const type = node.get("type");

    if (
        type === "bind" ||
        type === "tmpfs" ||
        type === "npipe" ||
        type === "cluster" ||
        type === "image"
    ) {
        return;
    }

    const source = node.get("source", true);

    if (isScalar(source) && Predicate.isString(source.value) && isNamedVolumeSource(source.value)) {
        source.value = rename(source.value);
    }
};

const prefixServiceVolumes = (service: YAMLMap, rename: Rename): void => {
    const volumes = service.get("volumes", true);

    if (isSeq(volumes)) {
        for (const item of volumes.items) {
            if (isNode(item)) prefixVolumeMount(item, rename);
        }

        return;
    }

    if (isNode(volumes)) prefixVolumeMount(volumes, rename);
};

const prefixTopLevelNames = (entries: YAMLMap, rename: Rename): void => {
    for (const pair of entries.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            continue;
        }

        pair.key.value = rename(pair.key.value);
    }
};

const prefixServiceConfigs = (service: YAMLMap, rename: Rename): void => {
    const configs = service.get("configs", true);

    if (configs === undefined || configs === null) {
        return;
    }

    if (isSeq(configs)) {
        for (const item of configs.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
                continue;
            }

            if (isMap(item)) {
                const source = item.get("source", true);

                if (isScalar(source) && Predicate.isString(source.value)) {
                    source.value = rename(source.value);
                }

                continue;
            }

            throw new Error("Invalid configs entry");
        }

        return;
    }

    if (isScalar(configs) && Predicate.isString(configs.value)) {
        configs.value = rename(configs.value);

        return;
    }

    if (isMap(configs)) {
        const source = configs.get("source", true);

        if (isScalar(source) && Predicate.isString(source.value)) {
            source.value = rename(source.value);
        }

        return;
    }

    throw new Error("Invalid configs entry");
};

const prefixColonRef = (value: string, rename: Rename): string => {
    const separatorIndex = value.indexOf(":");

    if (separatorIndex === -1) {
        return rename(value);
    }

    return `${rename(value.slice(0, separatorIndex))}${value.slice(separatorIndex)}`;
};

const prefixServiceLinks = (service: YAMLMap, rename: Rename): void => {
    const links = service.get("links", true);

    if (!isSeq(links)) {
        return;
    }

    for (const item of links.items) {
        if (isScalar(item) && Predicate.isString(item.value)) {
            item.value = prefixColonRef(item.value, rename);
        }
    }
};

const prefixServiceExtends = (service: YAMLMap, rename: Rename): void => {
    const extendsNode = service.get("extends", true);

    if (!isMap(extendsNode)) {
        return;
    }

    const target = extendsNode.get("service", true);

    if (isScalar(target) && Predicate.isString(target.value)) {
        target.value = rename(target.value);
    }
};

const prefixServiceVolumesFrom = (service: YAMLMap, rename: Rename): void => {
    const volumesFrom = service.get("volumes_from", true);

    if (!isSeq(volumesFrom)) {
        return;
    }

    for (const item of volumesFrom.items) {
        if (isScalar(item) && Predicate.isString(item.value)) {
            item.value = prefixColonRef(item.value, rename);
        }
    }
};

const NETWORK_MODE_SERVICE_PREFIX = "service:";

const prefixServiceNetworkMode = (service: YAMLMap, rename: Rename): void => {
    const mode = service.get("network_mode", true);

    if (!isScalar(mode) || !Predicate.isString(mode.value)) {
        return;
    }

    if (mode.value.startsWith(NETWORK_MODE_SERVICE_PREFIX)) {
        mode.value = `${NETWORK_MODE_SERVICE_PREFIX}${rename(mode.value.slice(NETWORK_MODE_SERVICE_PREFIX.length))}`;
    }
};

const prefixServiceSecrets = (service: YAMLMap, rename: Rename): void => {
    const secrets = service.get("secrets", true);

    if (secrets === undefined || secrets === null) {
        return;
    }

    if (isSeq(secrets)) {
        for (const item of secrets.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
                continue;
            }

            if (isMap(item)) {
                const source = item.get("source", true);

                if (isScalar(source) && Predicate.isString(source.value)) {
                    source.value = rename(source.value);
                }

                continue;
            }

            throw new Error("Invalid secrets entry");
        }

        return;
    }

    if (isScalar(secrets) && Predicate.isString(secrets.value)) {
        secrets.value = rename(secrets.value);

        return;
    }

    if (isMap(secrets)) {
        const source = secrets.get("source", true);

        if (isScalar(source) && Predicate.isString(source.value)) {
            source.value = rename(source.value);
        }

        return;
    }

    throw new Error("Invalid secrets entry");
};

const prefixDependsOn = (service: YAMLMap, rename: Rename): void => {
    const dependsOn = service.get("depends_on", true);

    if (isSeq(dependsOn)) {
        for (const item of dependsOn.items) {
            if (isScalar(item) && Predicate.isString(item.value)) {
                item.value = rename(item.value);
            }
        }

        return;
    }

    if (isMap(dependsOn)) {
        for (const pair of dependsOn.items) {
            if (isScalar(pair.key) && Predicate.isString(pair.key.value)) {
                pair.key.value = rename(pair.key.value);
            }
        }
    }
};

export const CADDY_UPSTREAMS_SERVICE = /(?<open>\{\{\s*upstreams\s+")(?<name>[^"]+)(?<close>")/gu;

// Only this file's services: another resource's service is named through a variable.
const prefixCaddyUpstreams = (
    service: YAMLMap,
    rename: Rename,
    serviceNames: ReadonlySet<string>,
): void => {
    const caddy = service.get("x-caddy", true);

    if (!isScalar(caddy) || !Predicate.isString(caddy.value)) {
        return;
    }

    caddy.value = caddy.value.replace(
        CADDY_UPSTREAMS_SERVICE,
        (match, open: string, name: string, close: string) =>
            serviceNames.has(name) ? `${open}${rename(name)}${close}` : match,
    );
};

const prefixServiceFragment = (
    service: YAMLMap,
    rename: Rename,
    serviceNames: ReadonlySet<string>,
): void => {
    prefixServiceVolumes(service, rename);
    prefixServiceConfigs(service, rename);
    prefixServiceSecrets(service, rename);
    prefixDependsOn(service, rename);
    prefixServiceLinks(service, rename);
    prefixServiceExtends(service, rename);
    prefixServiceVolumesFrom(service, rename);
    prefixServiceNetworkMode(service, rename);
    prefixCaddyUpstreams(service, rename, serviceNames);
    rewriteServiceEnvironment(service, serviceNames, rename);
};

/**
 * Prefix service-style references inside YAML anchors merged into services
 * (e.g. `x-base: &base` + `<<: *base`). Anchors are resolved
 * precisely through their aliases so unrelated `x-*` extensions are untouched.
 */
const prefixMergedAnchors = (
    doc: ReturnType<typeof YAML.parseDocument>,
    serviceMap: YAMLMap,
    rename: Rename,
    serviceNames: ReadonlySet<string>,
): void => {
    const seen = new Set<string>();

    const collectMergeAliases = (node: Node): void => {
        if (isAlias(node)) {
            if (seen.has(node.source)) {
                return;
            }

            seen.add(node.source);
            const target = node.resolve(doc);

            if (isMap(target)) {
                prefixServiceFragment(target, rename, serviceNames);
                const merged = target.get("<<", true);

                if (isNode(merged)) collectMergeAliases(merged);
            }

            return;
        }

        if (isSeq(node)) {
            for (const item of node.items) {
                if (isNode(item)) collectMergeAliases(item);
            }
        }
    };

    for (const pair of serviceMap.items) {
        if (isMap(pair.value)) {
            const merged = pair.value.get("<<", true);

            if (isNode(merged)) collectMergeAliases(merged);
        }
    }
};

/**
 * Rewrite a single environment value so inter-service references keep working
 * after prefixing. Only exact matches are rewritten: a value that is exactly
 * a service name (or `<service>.internal`), or a URL whose authority host is
 * one of those values. Substrings, external hosts, ports, paths, and
 * credentials are left byte-identical.
 * Exported so future deploy-time env merging (DB-backed vars, .env files)
 * can apply the same rename.
 */
export const rewriteComposeHostname = (
    value: string,
    serviceNames: ReadonlySet<string>,
    rename: Rename,
): string => {
    if (serviceNames.has(value)) {
        return rename(value);
    }

    if (value.endsWith(".internal") && serviceNames.has(value.slice(0, -".internal".length))) {
        return `${rename(value.slice(0, -".internal".length))}.internal`;
    }

    const schemeIndex = value.indexOf("://");

    if (schemeIndex === -1) {
        return value;
    }

    const authorityStart = schemeIndex + "://".length;
    let authorityEnd = value.length;

    for (const end of ["/", "?", "#"]) {
        const index = value.indexOf(end, authorityStart);

        if (index !== -1) {
            authorityEnd = Math.min(authorityEnd, index);
        }
    }

    const authority = value.slice(authorityStart, authorityEnd);
    const atIndex = authority.lastIndexOf("@");
    const hostWithPort = atIndex === -1 ? authority : authority.slice(atIndex + 1);

    // Service names never contain ":" or brackets; strip a :port suffix but
    // leave [ipv6] literals alone (they can never match a service name).
    let host = hostWithPort;

    if (!host.startsWith("[") && host.includes(":")) {
        host = host.slice(0, host.indexOf(":"));
    }

    const internalSuffix = host.endsWith(".internal") ? ".internal" : "";
    const serviceHost = internalSuffix ? host.slice(0, -internalSuffix.length) : host;

    if (!serviceNames.has(serviceHost)) {
        return value;
    }

    const hostStart = authorityStart + atIndex + 1 + hostWithPort.indexOf(host);

    return `${value.slice(0, hostStart)}${rename(serviceHost)}${internalSuffix}${value.slice(hostStart + host.length)}`;
};

const rewriteServiceEnvironment = (
    service: YAMLMap,
    serviceNames: ReadonlySet<string>,
    rename: Rename,
): void => {
    const environment = service.get("environment", true);

    if (isSeq(environment)) {
        for (const item of environment.items) {
            if (!isScalar(item) || !Predicate.isString(item.value)) {
                continue;
            }

            // Bare `KEY` entries expose a host variable with no value to rewrite.
            const separatorIndex = item.value.indexOf("=");

            if (separatorIndex === -1) {
                continue;
            }

            const rewritten = rewriteComposeHostname(
                item.value.slice(separatorIndex + 1),
                serviceNames,
                rename,
            );

            if (rewritten !== item.value.slice(separatorIndex + 1)) {
                item.value = `${item.value.slice(0, separatorIndex + 1)}${rewritten}`;
            }
        }

        return;
    }

    if (isMap(environment)) {
        for (const pair of environment.items) {
            if (isScalar(pair.value) && Predicate.isString(pair.value.value)) {
                pair.value.value = rewriteComposeHostname(pair.value.value, serviceNames, rename);
            }
        }
    }
};

function transformComposeNames(compose: string, rename: Rename): FormattedCompose {
    const doc = YAML.parseDocument(compose);

    if (doc.errors.length > 0) {
        throw new Error("Invalid compose YAML");
    }

    const serviceMap = doc.get("services", true);

    if (!isMap(serviceMap)) {
        throw new Error('Compose must contain a "services" map');
    }

    // Collect raw names first: environment values are matched against this
    // set, so it must be complete before any renaming happens.
    const rawNames = new Set<string>();

    for (const pair of serviceMap.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            throw new Error("Invalid service name");
        }

        rawNames.add(pair.key.value);
    }

    const serviceNames: string[] = [];

    for (const pair of serviceMap.items) {
        if (!isScalar(pair.key) || !Predicate.isString(pair.key.value)) {
            throw new Error("Invalid service name");
        }

        const serviceName = rename(pair.key.value);
        pair.key.value = serviceName;
        serviceNames.push(serviceName);

        if (isMap(pair.value)) {
            prefixServiceFragment(pair.value, rename, rawNames);
        }
    }

    prefixMergedAnchors(doc, serviceMap, rename, rawNames);

    for (const key of ["volumes", "configs", "secrets"]) {
        const entries = doc.get(key, true);

        if (isMap(entries)) prefixTopLevelNames(entries, rename);
    }

    return {
        serviceCount: serviceNames.length,
        serviceNames,
        yaml: doc.toString(),
    };
}

export function formatComposeFile(compose: string, prefix?: string): FormattedCompose {
    return transformComposeNames(compose, (name) => prefixName(name, prefix));
}

export const resourceEnv = (resource: { settings: unknown }): string =>
    Predicate.isObject(resource.settings) && Predicate.isString(resource.settings.env)
        ? resource.settings.env
        : "";

// Uncloud reads `configs.*.file` next to a temporary copy of the Compose file, so relative
// paths never resolve. Git-backed resources ship those files with each deployment instead.
function relativeConfigFiles(doc: YAML.Document) {
    const configs = doc.get("configs", true);

    if (!isMap(configs)) return [];

    return configs.items.flatMap(({ value: config }) => {
        const file = isMap(config) ? config.get("file", true) : undefined;

        return isMap(config) &&
            isScalar(file) &&
            Predicate.isString(file.value) &&
            !posix.isAbsolute(file.value)
            ? [{ config, file: file.value }]
            : [];
    });
}

/** Relative `configs.*.file` paths, as written in the Compose file. */
export function composeConfigFiles(compose: string): string[] {
    return relativeConfigFiles(YAML.parseDocument(compose)).map(({ file }) => file);
}

/**
 * Replaces each relative `configs.*.file` that has an entry in `files` with inline `content`.
 * Run it after `interpolateCompose`: `$` is escaped so file contents (nginx `$host`) stay literal.
 */
export function inlineComposeConfigs(compose: string, files: Record<string, string>): string {
    const doc = YAML.parseDocument(compose);
    let inlined = false;

    for (const { config, file } of relativeConfigFiles(doc)) {
        if (!Object.hasOwn(files, file)) continue;
        config.delete("file");
        config.set(
            "content",
            (files[file] ?? "").replaceAll("$", () => "$$"),
        );
        inlined = true;
    }

    return inlined ? doc.toString() : compose;
}

export class ComposeVariableError extends Error {}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*/u;

/** Resolved reference values keyed by `<resourceId>.<KEY>`. */
export type VariableReferences = Record<string, string>;

/**
 * Compose-spec interpolation of `$VAR`, `${VAR}`, and `${VAR[:]-|?|+...}` in YAML values.
 * Output keeps `$` escaped as `$$`, so Uncloud's own interpolation pass is a no-op
 * and never falls back to the sidecar's process environment.
 */
export function interpolateCompose(
    compose: string,
    envText: string,
    prefix?: string,
    domain?: string,
    references?: VariableReferences,
    identity?: ResourceIdentity,
): string {
    const doc = YAML.parseDocument(compose);

    const { env, expand, names } = composeEnvironment(
        doc,
        envText,
        prefix,
        domain,
        references,
        identity,
    );

    assertNoComposeReference(compose);

    YAML.visit(doc, {
        Scalar(key, node) {
            if (key !== "key" && Predicate.isString(node.value)) node.value = expand(node.value);
        },
    });

    // The resolved Variables, without the built-ins: what a real `.env` file would hold.
    const variables: Record<string, string> = {};

    for (const name of names) {
        const value = env[name];

        if (value !== undefined) variables[name] = value;
    }

    inlineEnvFiles(doc, variables);

    return doc.toString();
}

/** Each service's image in an `interpolateCompose` result, as the cluster will pull it. */
export function composeImages(compose: string) {
    const services = YAML.parseDocument(compose).get("services", true);
    const images: Record<string, string> = {};

    if (!isMap(services)) return images;

    for (const { key, value: service } of services.items) {
        const image = isMap(service) ? service.get("image") : undefined;

        if (isScalar(key) && Predicate.isString(key.value) && Predicate.isString(image))
            images[key.value] = image.replaceAll("$$", "$");
    }

    return images;
}

const RESOURCE_ENV_FILE = /^(?:\.\/)?\.env$/u;

/** A service's `env_file` entries: short form `- .env`, or long form `- path: .env` with an optional `required: false`. */
function envFiles(service: YAMLMap) {
    const entries = service.get("env_file", true);

    if (entries === undefined) return [];

    return (isSeq(entries) ? entries.items : [entries]).map((entry) => {
        const path = isMap(entry) ? entry.get("path") : isScalar(entry) ? entry.value : entry;

        return {
            path: Predicate.isString(path) ? path : String(path),
            required: !isMap(entry) || entry.get("required") !== false,
        };
    });
}

/** Whether a service reads the resource's Variables through `env_file: .env`, so it sees all of them. */
export function loadsResourceEnv(service: YAMLMap) {
    return envFiles(service).some(({ path }) => RESOURCE_ENV_FILE.test(path));
}

/**
 * Uncloud loads Compose from a temporary directory with no `.env` beside it, so
 * `env_file: .env` (the resource's Variables) becomes plain `environment` entries.
 * A resource's only service gets them without it, like a Railway service.
 * Keys already in `environment` win, as in Compose. No other env file exists there.
 */
function inlineEnvFiles(doc: YAML.Document, variables: Record<string, string>) {
    const services = doc.get("services", true);

    if (!isMap(services)) return;

    for (const { key, value: service } of services.items) {
        if (!isMap(service)) continue;

        const unreadable = envFiles(service).find(
            ({ path, required }) => required && !RESOURCE_ENV_FILE.test(path),
        );

        if (unreadable)
            throw new ComposeVariableError(
                `Service ${String(key)} loads env_file ${unreadable.path}, which a deploy cannot read. Put those variables in the resource's Variables and use env_file: .env.`,
            );

        const usesResourceEnv = services.items.length === 1 || loadsResourceEnv(service);

        service.delete("env_file");

        if (usesResourceEnv) mergeEnvironment(doc, service, variables);
    }
}

/** A map's entries as Compose reads them: `<<` merges resolved, under the map's own keys. */
function mergedEntries(doc: YAML.Document, map: YAMLMap) {
    const entries = new Map<string, Node | null>();
    const merges: Node[] = [];

    for (const pair of map.items) {
        const key = String(isScalar(pair.key) ? pair.key.value : pair.key);

        if (key !== "<<") entries.set(key, isNode(pair.value) ? pair.value : null);
        else if (isNode(pair.value)) merges.push(pair.value);
    }

    // Within one `<<: [*a, *b]`, earlier sources win.
    for (const merge of merges)
        for (const item of isSeq(merge) ? merge.items : [merge]) {
            const source = isNode(item) ? resolvedNode(doc, item) : undefined;

            if (!isMap(source)) continue;

            for (const [key, value] of mergedEntries(doc, source))
                if (!entries.has(key)) entries.set(key, value);
        }

    return entries;
}

/** A plain copy of `node`: no anchors, nested aliases resolved. */
function anchorlessCopy(doc: YAML.Document, node: Node) {
    return doc.createNode(node.toJS(doc));
}

/**
 * Turns every alias of an anchor inside `node` into a copy of what it names, so `node` can be
 * replaced without leaving those aliases unresolved.
 */
function detachAliases(doc: YAML.Document, node: Node) {
    const anchored = new Set<Node>();

    YAML.visit(node, {
        Node(_, child) {
            if (child.anchor) anchored.add(child);
        },
    });

    if (anchored.size === 0) return;

    YAML.visit(doc, {
        Alias(_, alias) {
            const target = alias.resolve(doc);

            return target && anchored.has(target) ? anchorlessCopy(doc, target) : undefined;
        },
    });
}

function resolvedNode(doc: YAML.Document, node: Node | null | undefined) {
    return isAlias(node) ? node.resolve(doc) : (node ?? undefined);
}

/**
 * Adds the Variables `environment` doesn't set. The service gets its own copy, since an
 * anchored or merged environment is shared with other services, and keys it gets that way
 * stay ahead of the Variables.
 */
function mergeEnvironment(doc: YAML.Document, service: YAMLMap, variables: Record<string, string>) {
    // The document is already interpolated, so a literal `$` stays escaped as `$$`.
    const escape = (value: string) => value.replaceAll("$", "$$$$");
    const environment = resolvedNode(doc, mergedEntries(doc, service).get("environment"));
    const own = service.get("environment", true);

    // The service's own environment is replaced below, taking any anchor it defines with it.
    if (isNode(own) && !isAlias(own)) detachAliases(doc, own);

    if (isSeq(environment)) {
        const lines = environment.items.flatMap((item) => {
            const node = isNode(item) ? resolvedNode(doc, item) : undefined;

            return isScalar(node) ? [String(node.value)] : [];
        });

        const defined = new Set(lines.map((line) => line.split("=", 1)[0]));

        for (const [name, value] of Object.entries(variables))
            if (!defined.has(name)) lines.push(`${name}=${escape(value)}`);

        service.set("environment", doc.createNode(lines));

        return;
    }

    const map = new YAMLMap();

    if (isMap(environment))
        for (const [name, value] of mergedEntries(doc, environment)) {
            const node = resolvedNode(doc, value);

            map.set(name, isScalar(node) ? anchorlessCopy(doc, node) : null);
        }

    for (const [name, value] of Object.entries(variables))
        if (!map.has(name)) map.set(name, escape(value));

    service.set("environment", map);
}

/**
 * References belong in Variables; one written in Compose (not in a comment) would deploy as
 * literal text. Only real resource ids count here, so templating such as
 * `{{ $labels.instance }}` in configs keeps working.
 */
export function assertNoComposeReference(compose: string) {
    let found: string | undefined;

    YAML.visit(YAML.parseDocument(compose), {
        Scalar(_, node) {
            if (!Predicate.isString(node.value)) return;

            for (const [reference, id = ""] of node.value.matchAll(VARIABLE_REFERENCE))
                if (referenceResourceId(id)) found ??= reference;

            if (found) return YAML.visit.BREAK;
        },
    });

    if (found)
        throw new ComposeVariableError(
            `Variable references only work in the resource's Variables, not in Compose: ${found}. Add NAME=${found} to Variables and use \${NAME} in Compose.`,
        );
}

/**
 * What services set in Compose `environment`, interpolated like a deploy. When two services
 * set the same key, the first service in the file wins.
 */
export function composeServiceVariables(
    compose: string,
    envText: string,
    prefix?: string,
    domain?: string,
    identity?: ResourceIdentity,
): Record<string, string> {
    const doc = YAML.parseDocument(
        interpolateCompose(compose, envText, prefix, domain, undefined, identity),
    );

    const services = doc.get("services", true);
    const variables: Record<string, string> = {};

    if (!isMap(services)) return variables;

    for (const { value: service } of services.items) {
        if (!isMap(service)) continue;

        const environment = resolvedNode(doc, mergedEntries(doc, service).get("environment"));
        let entries: [string, string][] = [];

        if (isSeq(environment))
            entries = environment.items.flatMap((item) => {
                const node = isNode(item) ? resolvedNode(doc, item) : undefined;
                const line = isScalar(node) ? String(node.value) : "";
                const split = line.indexOf("=");

                // Bare `KEY` entries pass a host variable through and have no value here.
                return split === -1 ? [] : [[line.slice(0, split), line.slice(split + 1)]];
            });
        else if (isMap(environment))
            entries = [...mergedEntries(doc, environment)].flatMap(([name, value]) => {
                const node = resolvedNode(doc, value);

                return isScalar(node) && node.value !== null ? [[name, String(node.value)]] : [];
            });

        // Interpolated output keeps `$` escaped as `$$`.
        for (const [name, value] of entries) variables[name] ??= value.replaceAll("$$", "$");
    }

    return variables;
}

/** Every variable a resource's Compose sees: built-ins plus its resolved `.env`. */
export function composeVariables(
    compose: string,
    envText: string,
    prefix?: string,
    domain?: string,
    references?: VariableReferences,
    identity?: ResourceIdentity,
): Record<string, string> {
    return composeEnvironment(
        YAML.parseDocument(compose),
        envText,
        prefix,
        domain,
        references,
        identity,
    ).env;
}

/** The project and resource a Compose file belongs to, for the `STOAT_PROJECT_*` / `STOAT_RESOURCE_*` built-ins. */
export type ResourceIdentity = {
    projectId: string;
    projectName: string;
    resourceId: string;
    resourceName: string;
};

/** A built-in variable, like Railway's "variables added by Railway". */
export type SystemVariable = {
    key: string;
    value: string;
    description: string;
};

/** The built-ins a resource's Compose sees, with the values a deploy would use. */
export function composeSystemVariables(
    compose: string,
    envText: string,
    prefix?: string,
    domain?: string,
    identity?: ResourceIdentity,
): SystemVariable[] {
    return composeEnvironment(
        YAML.parseDocument(compose),
        envText,
        prefix,
        domain,
        undefined,
        identity,
    ).system;
}

/**
 * Stoat's counterpart of Railway's provided variables. Service-scoped ones are per
 * Compose service (`<SERVICE>_...`), since a resource can run several.
 */
function systemVariables(
    doc: YAML.Document,
    prefix: string | undefined,
    domain: string | undefined,
    identity: ResourceIdentity | undefined,
    hostnames: Map<string, string>,
): SystemVariable[] {
    const variables: SystemVariable[] = [
        {
            key: "STOAT_PREFIX",
            value: prefix ?? "",
            description:
                "Prefix of this resource's service, network and volume names; empty when prefixing is off.",
        },
    ];

    if (domain)
        variables.push({
            key: "STOAT_DOMAIN",
            value: domain,
            description: "The cluster's domain, for building public hostnames.",
        });

    if (identity)
        variables.push(
            {
                key: "STOAT_PROJECT_NAME",
                value: identity.projectName,
                description: "The project name the resource belongs to.",
            },
            {
                key: "STOAT_PROJECT_ID",
                value: identity.projectId,
                description: "The project ID the resource belongs to.",
            },
            {
                key: "STOAT_RESOURCE_NAME",
                value: identity.resourceName,
                description: "The resource name.",
            },
            {
                key: "STOAT_RESOURCE_ID",
                value: identity.resourceId,
                description: "The resource ID.",
            },
        );

    const services = doc.get("services", true);

    if (isMap(services))
        for (const { key } of services.items)
            if (isScalar(key) && Predicate.isString(key.value)) {
                const variable = serviceVariable(key.value);
                const name = prefixName(key.value, prefix);
                const hostname = hostnames.get(key.value);

                variables.push(
                    {
                        key: `${variable}_SERVICE_NAME`,
                        value: name,
                        description: `The deployed name of the ${key.value} service.`,
                    },
                    {
                        key: `${variable}_INTERNAL_HOST`,
                        value: internalHostname(key.value, prefix),
                        description: `The private DNS name of the ${key.value} service.`,
                    },
                );

                if (hostname)
                    variables.push({
                        key: `${variable}_PUBLIC_DOMAIN`,
                        value: hostname,
                        description: `The public domain of the ${key.value} service, from its x-ports.`,
                    });
            }

    // `web-app` and `web_app` share `WEB_APP_*`; the first service keeps the name.
    const seen = new Set<string>();

    return variables.filter((variable) => {
        if (seen.has(variable.key)) return false;

        seen.add(variable.key);

        return true;
    });
}

/**
 * Built-ins from `systemVariables`, each overridable by a same-named user variable.
 * Without `references`, `{{ ... }}` reference text is kept as-is.
 */
function composeEnvironment(
    doc: YAML.Document,
    envText: string,
    prefix?: string,
    domain?: string,
    references?: VariableReferences,
    identity?: ResourceIdentity,
) {
    if (doc.errors.length > 0) throw new Error("Invalid compose YAML");

    let system = systemVariables(doc, prefix, domain, identity, new Map());
    let env: Record<string, string> = {};

    const expand = (text: string): string => {
        let out = "";

        for (let i = 0; i < text.length;) {
            const char = text[i]!;

            if (char !== "$") {
                out += char;
                i++;
                continue;
            }

            const next = text[i + 1];

            if (next === "$") {
                out += "$$";
                i += 2;
                continue;
            }

            if (next !== "{") {
                const name = VARIABLE.exec(text.slice(i + 1))?.[0];

                out += name ? (env[name] ?? "").replaceAll("$", "$$$$") : "$$";
                i += 1 + (name?.length ?? 0);
                continue;
            }

            // Find the matching brace; nested `${...}` may appear in defaults.
            let depth = 1;
            let end = i + 2;

            for (; end < text.length && depth > 0; end++) {
                if (text[end] === "$" && text[end + 1] === "$") end++;
                else if (text[end] === "$" && text[end + 1] === "{") {
                    depth++;
                    end++;
                } else if (text[end] === "}") depth--;
            }

            if (depth > 0) throw new ComposeVariableError(`Invalid interpolation format: ${text}`);

            const body = text.slice(i + 2, end - 1);
            const name = VARIABLE.exec(body)?.[0];

            if (!name) throw new ComposeVariableError(`Invalid interpolation format: ${text}`);

            const rest = body.slice(name.length);
            const colon = rest.startsWith(":");
            const op = rest[colon ? 1 : 0];
            const arg = rest.slice(colon ? 2 : 1);
            const value = env[name];
            const present = colon ? !!value : value !== undefined;
            const escaped = (value ?? "").replaceAll("$", "$$$$");

            if (rest === "") out += escaped;
            else if (op === "-") out += present ? escaped : expand(arg);
            else if (op === "+") out += present ? expand(arg) : "";
            else if (op === "?") {
                if (!present)
                    throw new ComposeVariableError(
                        `Required variable ${name} is missing a value${arg ? `: ${arg}` : ""}. Set it in the resource's Variables.`,
                    );
                out += escaped;
            } else throw new ComposeVariableError(`Invalid interpolation format: ${text}`);

            i = end;
        }

        return out;
    };

    // Referenced values are literal, so `$` is escaped before `expand` sees it.
    const substitute = (value: string) =>
        references
            ? value.replaceAll(VARIABLE_REFERENCE, (reference, id: string, key: string) => {
                  const resolved = references[`${referenceResourceId(id)}.${key}`];

                  if (resolved === undefined)
                      throw new ComposeVariableError(`Unresolved variable reference ${reference}.`);

                  return resolved.replaceAll("$", "$$$$");
              })
            : value;

    // Like Compose, .env values may reference variables defined above them.
    // parseEnv returns keys sorted, so walk them in file order instead.
    const values = parseEnv(envText);

    const fileOrder = parseAllAssignments(envText);

    // Like Compose, single-quoted values are literal; parseEnv drops the quotes, so the last
    // assignment of each key decides.
    const literal = new Map(fileOrder.map(({ key, quote }) => [key, quote === "'"]));

    // Keys the line scan misses still resolve, after the ordered ones.
    const names = new Set([...literal.keys(), ...Object.keys(values)]);

    // A lenient pass skips values that fail, e.g. `${WEB_PUBLIC_DOMAIN:?}` before domains are known.
    const resolve = (strict: boolean) => {
        env = Object.fromEntries(system.map((variable) => [variable.key, variable.value]));

        for (const name of names)
            if (values[name] !== undefined && literal.get(name)) env[name] = values[name];
            else if (values[name] !== undefined)
                try {
                    env[name] = expand(substitute(values[name])).replaceAll("$$", "$");
                } catch (error) {
                    if (strict || !(error instanceof ComposeVariableError)) throw error;
                }
    };

    resolve(false);

    // x-ports hostnames are often built from Variables, so public domains are only known
    // after one pass. The strict second pass lets Variables use `${<SERVICE>_PUBLIC_DOMAIN}` too.
    const hostnames = new Map<string, string>();

    try {
        for (const entry of parseIngressComposeWith(doc.toString(), (name) => env[name]).entries)
            if (entry.kind === "http" && entry.hostname && !hostnames.has(entry.service))
                hostnames.set(entry.service, entry.hostname);
    } catch {
        // Public domains are best effort; the deploy reports Compose problems itself.
    }

    system = systemVariables(doc, prefix, domain, identity, hostnames);
    resolve(true);

    return { env, expand, names, system };
}

/** Undo only the transformations made by formatComposeFile; keep user YAML intact. */
export function unformatComposeFile(compose: string, prefix?: string): string {
    const separator = prefix ? `${prefix}-` : undefined;

    const result = transformComposeNames(compose, (name) =>
        separator && name.startsWith(separator) ? name.slice(separator.length) : name,
    );

    // A redeploy may introduce two names that collapse to the same unprefixed key.
    if (YAML.parseDocument(result.yaml).errors.length > 0) {
        throw new Error("Compose names collide after removing the Stoat prefix");
    }

    return result.yaml;
}
