// Ported from stoat-old's src/lib/server/deployments/deployment-compose.ts:
// only the formatting/prefixing core, shared by previews and deployment workers.

import YAML, { isAlias, isMap, isNode, isScalar, isSeq } from "yaml";
import type { Node, YAMLMap } from "yaml";
import { Predicate } from "effect";
import { posix } from "node:path";
import { parseEnv } from "node:util";
import { referenceResourceId, VARIABLE_REFERENCE } from "./variable-reference";

export interface FormattedCompose {
    serviceCount: number;
    serviceNames: string[];
    yaml: string;
}

/**
 * Deployment prefix for a resource compose spec:
 * `<first 8 of project id>-<first 8 of resource id>`, e.g. `a1b2c3d4-e5f6a7b8-web`.
 * Short enough to stay readable, unique enough that Uncloud treats each
 * resource's services and volumes as distinct. Returns undefined when the
 * resource opted out via `settings.prefixNames === false`.
 */
export function resourceComposePrefix(resource: {
    projectId: string;
    id: string;
    settings: unknown;
}): string | undefined {
    if (Predicate.isObject(resource.settings) && resource.settings.prefixNames === false) {
        return undefined;
    }

    return `${resource.projectId.slice(0, 8)}-${resource.id.slice(0, 8)}`;
}

const prefixName = (name: string, prefix?: string): string => {
    if (!prefix) {
        return name;
    }

    return `${prefix}-${name}`;
};

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

const CADDY_UPSTREAMS_SERVICE = /(?<open>\{\{\s*upstreams\s+")(?<name>[^"]+)(?<close>")/gu;

const prefixCaddyUpstreams = (service: YAMLMap, rename: Rename): void => {
    const caddy = service.get("x-caddy", true);

    if (!isScalar(caddy) || !Predicate.isString(caddy.value)) {
        return;
    }

    caddy.value = caddy.value.replace(
        CADDY_UPSTREAMS_SERVICE,
        (_match, open: string, name: string, close: string) => `${open}${rename(name)}${close}`,
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
    prefixCaddyUpstreams(service, rename);
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
): string {
    const doc = YAML.parseDocument(compose);
    const { expand } = composeEnvironment(doc, envText, prefix, domain, references);
    assertNoComposeReference(compose);

    YAML.visit(doc, {
        Scalar(key, node) {
            if (key !== "key" && Predicate.isString(node.value)) node.value = expand(node.value);
        },
    });

    return doc.toString();
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

/** Every variable a resource's Compose sees: built-ins plus its resolved `.env`. */
export function composeVariables(
    compose: string,
    envText: string,
    prefix?: string,
    domain?: string,
    references?: VariableReferences,
): Record<string, string> {
    return composeEnvironment(YAML.parseDocument(compose), envText, prefix, domain, references).env;
}

/**
 * Built-ins, each overridable by a same-named user variable:
 * `<SERVICE>_SERVICE_NAME` / `<SERVICE>_INTERNAL_HOST` (deployed name, prefixed when
 * `prefix` is set), `STOAT_PREFIX`, and `STOAT_DOMAIN` when the cluster domain is known.
 * Without `references`, `{{ ... }}` reference text is kept as-is.
 */
function composeEnvironment(
    doc: YAML.Document,
    envText: string,
    prefix?: string,
    domain?: string,
    references?: VariableReferences,
) {
    const env: Record<string, string> = {};

    if (doc.errors.length > 0) throw new Error("Invalid compose YAML");

    env.STOAT_PREFIX = prefix ?? "";

    if (domain) env.STOAT_DOMAIN = domain;

    const services = doc.get("services", true);

    if (isMap(services))
        for (const { key } of services.items)
            if (isScalar(key) && Predicate.isString(key.value)) {
                const variable = key.value.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
                const name = prefixName(key.value, prefix);

                env[`${variable}_SERVICE_NAME`] = name;
                env[`${variable}_INTERNAL_HOST`] = `${name}.internal`;
            }

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
    // ponytail: parseEnv drops quotes, so single-quoted values expand too; Compose keeps them literal.
    const values = parseEnv(envText);
    const fileOrder = envText.matchAll(/^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=/gmu);
    // Keys the line scan misses still resolve, after the ordered ones.

    const names = new Set([
        ...Array.from(fileOrder, ([, name = ""]) => name),
        ...Object.keys(values),
    ]);

    for (const name of names)
        if (values[name] !== undefined)
            env[name] = expand(substitute(values[name])).replaceAll("$$", "$");

    return { env, expand };
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
