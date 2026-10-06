// Uncloud ingress helpers: parse `x-ports` / `x-caddy` from a Compose spec and
// edit them back into the YAML, preserving comments and formatting.
// Docs: https://uncloud.run/docs/concepts/ingress/publishing-services

import { Predicate } from "effect";
import YAML, { Scalar, isMap, isScalar, isSeq } from "yaml";
import type { Document, YAMLMap } from "yaml";

export type HttpProtocol = "http" | "https";

export type HostProtocol = "tcp" | "udp";

export type HttpIngress = {
    kind: "http";
    service: string;
    hostname: string | null;
    containerPort: number;
    protocol: HttpProtocol;
    raw: string;
};

export type HostIngress = {
    kind: "host";
    service: string;
    bind: string | null;
    hostPort: number;
    containerPort: number;
    protocol: HostProtocol;
    raw: string;
};

export type CaddyIngress = {
    kind: "caddy";
    service: string;
    caddy: string;
    fileRef: boolean;
};

export type IngressEntry = HttpIngress | HostIngress | CaddyIngress;

export type IngressIssue = {
    service: string;
    message: string;
};

export type IngressSnapshot = {
    services: string[];
    entries: IngressEntry[];
    caddyRoutes: CaddyRoute[];
    issues: IngressIssue[];
};

const HOSTNAME_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

const MAX_PORT = 65535;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Browser-safe `.env` reader (subset of `node:util` parseEnv, which cannot
 * bundle for the client): `KEY=value` lines, `export ` prefix, `#` comments,
 * single/double/backtick quotes. Values stay single-line, matching the
 * Variables form validation.
 */
export function parseEnvText(envText: string): Map<string, string> {
    const vars = new Map<string, string>();

    for (const line of envText.split("\n")) {
        const trimmed = line.trim();

        if (trimmed === "" || trimmed.startsWith("#")) continue;

        const unexported = trimmed.startsWith("export ")
            ? trimmed.slice("export ".length).trimStart()
            : trimmed;

        const separator = unexported.indexOf("=");

        if (separator <= 0) continue;

        const key = unexported.slice(0, separator).trim();

        if (!ENV_NAME.test(key)) continue;

        let value = unexported.slice(separator + 1).trim();
        const quote = value[0];

        if (quote === '"' || quote === "'" || quote === "`") {
            const end = value.indexOf(quote, 1);
            value = end === -1 ? value.slice(1) : value.slice(1, end);
        } else {
            const comment = value.indexOf(" #");
            value = (comment === -1 ? value : value.slice(0, comment)).trim();
        }

        vars.set(key, value);
    }

    return vars;
}

type VarLookup = (name: string) => string | undefined;

const isVarChar = (char: string): boolean => /[\w]/u.test(char);

function readBracedEnd(text: string, start: number): number {
    let depth = 1;
    let index = start;

    while (index < text.length && depth > 0) {
        if (text.startsWith("${", index)) {
            depth += 1;
            index += 2;

            continue;
        }

        if (text[index] === "}") {
            depth -= 1;
            index += 1;

            continue;
        }

        index += 1;
    }

    return index;
}

function resolveBraced(expression: string, lookup: VarLookup): string {
    let nameEnd = 0;

    while (nameEnd < expression.length && isVarChar(expression[nameEnd] ?? "")) nameEnd += 1;

    const name = expression.slice(0, nameEnd);
    const rest = expression.slice(nameEnd);
    const value = lookup(name);

    if (rest === "") return value ?? "";

    const emptyIsUnset = rest.startsWith(":");
    const operator = emptyIsUnset ? rest[1] : rest[0];
    const argument = rest.slice(emptyIsUnset ? 2 : 1);
    const isSet = emptyIsUnset ? value !== undefined && value !== "" : value !== undefined;

    if (operator === "-")
        return isSet ? (value ?? "") : interpolateComposeVariables(argument, lookup);

    if (operator === "+") return isSet ? interpolateComposeVariables(argument, lookup) : "";

    // Best-effort: display contexts never fail on required (`?`) variables.
    return value ?? "";
}

/**
 * Lenient docker-compose style `$VAR`/`${VAR}` expansion for display parsing.
 * Supports `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `${VAR+alt}`,
 * nested defaults, and the `$$` escape. Unset variables become `""`; never
 * throws. Ported from stoat-old's compose-interpolate.
 */
export function interpolateComposeVariables(text: string, lookup: VarLookup): string {
    let result = "";
    let index = 0;

    while (index < text.length) {
        const char = text[index];

        if (char !== "$") {
            result += char;
            index += 1;

            continue;
        }

        if (text[index + 1] === "$") {
            result += "$";
            index += 2;

            continue;
        }

        if (text[index + 1] === "{") {
            const end = readBracedEnd(text, index + 2);
            result += resolveBraced(text.slice(index + 2, end - 1), lookup);
            index = end;

            continue;
        }

        let nameEnd = index + 1;

        while (nameEnd < text.length && isVarChar(text[nameEnd] ?? "")) nameEnd += 1;

        if (nameEnd === index + 1) {
            result += "$";
            index += 1;

            continue;
        }

        result += lookup(text.slice(index + 1, nameEnd)) ?? "";
        index = nameEnd;
    }

    return result;
}

/** Null when the hostname is a valid DNS name (optional `*.` wildcard). */
export function hostnameError(hostname: string): string | null {
    const dotted = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
    const bare = dotted.startsWith("*.") ? dotted.slice(2) : dotted;

    if (bare.length === 0) return "Hostname is empty.";

    if (hostname.length > 253) return `Hostname "${hostname}" is too long.`;

    for (const label of bare.split(".")) {
        if (!HOSTNAME_LABEL.test(label)) return `Hostname "${hostname}" is not a valid DNS name.`;
    }

    return null;
}

/** Null when the text is an integer port in range. */
export function portTextError(portText: string): string | null {
    if (!/^[0-9]+$/u.test(portText)) return `"${portText}" is not a valid port.`;

    const port = Number(portText);

    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
        return `"${portText}" is not a valid port. Use 1-65535.`;

    return null;
}

function ipv4Error(value: string): string | null {
    const parts = value.split(".");

    if (parts.length !== 4) return `Bind address "${value}" is not a valid IP.`;

    for (const part of parts) {
        if (!/^[0-9]{1,3}$/u.test(part) || Number(part) > 255)
            return `Bind address "${value}" is not a valid IP.`;
    }

    return null;
}

function ipv6Error(value: string): string | null {
    const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;

    if (!bare.includes(":")) return `Bind address "${value}" is not a valid IP.`;

    if ((bare.match(/::/gu) ?? []).length > 1) return `Bind address "${value}" is not a valid IP.`;

    const groups = bare.split(":");
    const compressed = bare.includes("::");

    if (groups.length > 8 || (!compressed && groups.length !== 8))
        return `Bind address "${value}" is not a valid IP.`;

    for (const group of groups) {
        if (group !== "" && !/^[0-9A-Fa-f]{1,4}$/u.test(group))
            return `Bind address "${value}" is not a valid IP.`;
    }

    return null;
}

/** Null when the bind is an IP or CIDR prefix. Empty means all interfaces. */
export function bindError(bind: string): string | null {
    const trimmed = bind.trim();

    if (trimmed === "") return null;

    const slash = trimmed.indexOf("/");

    if (slash === -1) {
        const v4 = ipv4Error(trimmed) === null;
        const v6 = ipv6Error(trimmed) === null;

        if (v4 || v6) return null;

        return `Bind address "${bind}" is not a valid IP or CIDR prefix.`;
    }

    const address = trimmed.slice(0, slash);
    const prefix = trimmed.slice(slash + 1);
    const isV4 = ipv4Error(address) === null;
    const isV6 = !isV4 && ipv6Error(address) === null;

    if (!isV4 && !isV6) return `Bind address "${bind}" is not a valid IP or CIDR prefix.`;

    if (!/^[0-9]+$/u.test(prefix))
        return `Bind address "${bind}" is not a valid IP or CIDR prefix.`;

    const bits = Number(prefix);

    if (isV4 ? bits > 32 : bits > 128)
        return `Bind address "${bind}" is not a valid IP or CIDR prefix.`;

    return null;
}

/**
 * Split `body/protocol`, matching only a trailing known protocol so CIDR
 * binds (`192.168.0.0/24:...`) keep their slash in the body.
 */
function splitProtocol(spec: string): [string, string | null] {
    const slash = spec.lastIndexOf("/");

    if (slash === -1) return [spec, null];

    const tail = spec.slice(slash + 1).toLowerCase();

    if (tail === "http" || tail === "https" || tail === "tcp" || tail === "udp")
        return [spec.slice(0, slash), tail];

    return [spec, null];
}

function parseHostSpec(
    service: string,
    spec: string,
    entries: IngressEntry[],
    issues: IngressIssue[],
    rawSpec: string,
): void {
    const withoutHost = spec.slice(0, -"@host".length);
    // The bind may be a CIDR prefix, so only the last segment can be a protocol.
    const [body, protocolRaw] = splitProtocol(withoutHost);
    const protocol = protocolRaw ?? "tcp";

    if (protocol !== "tcp" && protocol !== "udp") {
        issues.push({
            service,
            message: `"${rawSpec}" uses "${protocolRaw}" with @host; host mode supports tcp/udp. Drop @host for HTTP(S) ingress.`,
        });

        return;
    }

    const parts = body.split(":");

    if (parts.length < 2) {
        issues.push({
            service,
            message: `"${rawSpec}" needs host_port:container_port before @host.`,
        });

        return;
    }

    const containerRaw = parts.pop() ?? "";
    const hostRaw = parts.pop() ?? "";
    const bindJoined = parts.join(":");
    const bind = bindJoined === "" ? null : bindJoined;
    const hostIssue = portTextError(hostRaw);
    const containerIssue = portTextError(containerRaw);

    if (hostIssue !== null || containerIssue !== null) {
        issues.push({ service, message: `"${rawSpec}" has an invalid port. Use 1-65535.` });

        return;
    }

    if (bind !== null && bindError(bind) !== null) {
        issues.push({
            service,
            message: `"${rawSpec}" has an invalid bind address. Use an IP or CIDR prefix.`,
        });

        return;
    }

    entries.push({
        kind: "host",
        service,
        bind,
        hostPort: Number(hostRaw),
        containerPort: Number(containerRaw),
        protocol,
        raw: rawSpec,
    });
}

function parsePortSpec(
    service: string,
    spec: string,
    entries: IngressEntry[],
    issues: IngressIssue[],
    rawSpec: string,
): void {
    if (spec.endsWith("@host")) {
        parseHostSpec(service, spec, entries, issues, rawSpec);

        return;
    }

    const [body, protocolRaw] = splitProtocol(spec);

    if (body.includes("/")) {
        issues.push({ service, message: `"${rawSpec}" is not a valid publish entry.` });

        return;
    }

    const protocol = protocolRaw ?? "https";

    if (protocol !== "http" && protocol !== "https") {
        issues.push({
            service,
            message: `"${rawSpec}" uses protocol "${protocolRaw}"; ingress ports support http/https. Append @host for tcp/udp.`,
        });

        return;
    }

    const parts = body.split(":");

    if (parts.length > 2) {
        issues.push({ service, message: `"${rawSpec}" is not a valid publish entry.` });

        return;
    }

    const hostname = parts.length === 2 ? (parts[0] ?? "") : null;
    const portRaw = parts.length === 2 ? (parts[1] ?? "") : (parts[0] ?? "");

    if (hostname !== null) {
        const issue = hostnameError(hostname);

        if (issue !== null) {
            issues.push({ service, message: `"${rawSpec}": ${issue}` });

            return;
        }
    }

    if (portTextError(portRaw) !== null) {
        issues.push({ service, message: `"${rawSpec}" has an invalid port. Use 1-65535.` });

        return;
    }

    entries.push({
        kind: "http",
        service,
        hostname: hostname === "" ? null : hostname,
        containerPort: Number(portRaw),
        protocol,
        raw: rawSpec,
    });
}

/** Raw shape of one `x-ports` string, without any validation. */
export type DecomposedPort =
    | { kind: "http"; hostname: string | null; portText: string; protocol: string }
    | {
          kind: "host";
          bind: string | null;
          hostPortText: string;
          containerPortText: string;
          protocol: string;
      };

/** Split a raw `x-ports` string into its written parts for edit prefills. */
export function decomposePortSpec(raw: string): DecomposedPort | null {
    const trimmed = raw.trim();

    if (trimmed === "") return null;

    if (trimmed.endsWith("@host")) {
        const [body, protocolRaw] = splitProtocol(trimmed.slice(0, -"@host".length));
        const parts = body.split(":");

        if (parts.length < 2) return null;

        const containerPortText = parts.pop() ?? "";
        const hostPortText = parts.pop() ?? "";
        const bindJoined = parts.join(":");

        return {
            kind: "host",
            bind: bindJoined === "" ? null : bindJoined,
            hostPortText,
            containerPortText,
            protocol: protocolRaw ?? "tcp",
        };
    }

    const [body, protocolRaw] = splitProtocol(trimmed);

    if (body.includes("/")) return null;

    const parts = body.split(":");

    if (parts.length > 2) return null;

    return {
        kind: "http",
        hostname: parts.length === 2 ? (parts[0] ?? "") : null,
        portText: parts.length === 2 ? (parts[1] ?? "") : (parts[0] ?? ""),
        protocol: protocolRaw ?? "https",
    };
}

/** Null when a raw `x-ports` string parses cleanly. */
export function specError(spec: string): string | null {
    const trimmed = spec.trim();

    if (trimmed === "") return "Publish entry must not be empty.";

    const entries: IngressEntry[] = [];
    const issues: IngressIssue[] = [];
    parsePortSpec("", trimmed, entries, issues, trimmed);

    if (issues.length > 0) return issues[0]?.message ?? "Invalid publish entry.";

    return null;
}

/** A single-line `x-caddy` without Caddy syntax is a Compose file reference. */
export function isCaddyFileRef(caddy: string): boolean {
    const trimmed = caddy.trim();

    if (trimmed === "" || trimmed.includes("\n")) return false;

    if (/[{}]/u.test(trimmed)) return false;

    return (
        trimmed === "Caddyfile" ||
        trimmed.startsWith("./") ||
        trimmed.startsWith("../") ||
        trimmed.startsWith("/") ||
        trimmed.startsWith("~/") ||
        /^[A-Za-z0-9_./-]+\.(caddyfile|caddy)$/iu.test(trimmed)
    );
}

/** An HTTP(S) route extracted from an `x-caddy` Caddyfile snippet. */
export type CaddyRoute = {
    /** Container port targeted by `{{upstreams ...}}`, when specified. */
    containerPort?: number;
    /** Site address without scheme or port. */
    host: string;
    /** Path matcher of the enclosing handle/handle_path/route block, if any. */
    path?: string;
    protocol: HttpProtocol;
    /** Compose service holding the `x-caddy` value. */
    serviceName: string;
    /** Compose service the traffic is proxied to (may differ from serviceName). */
    upstreamService: string;
};

const UPSTREAMS_PATTERN =
    /\{\{\s*upstreams(?:\s+"(?<service>[^"]+)")?(?:\s+(?<port>\d+))?\s*\}\}/gu;

function parseSiteAddress(address: string): { host: string; protocol: HttpProtocol } {
    let host = address;
    let protocol: HttpProtocol = "https";

    if (host.startsWith("http://")) {
        host = host.slice("http://".length);
        protocol = "http";
    } else if (host.startsWith("https://")) {
        host = host.slice("https://".length);
    }

    const portIndex = host.lastIndexOf(":");

    if (portIndex !== -1) {
        const port = host.slice(portIndex + 1);

        if (/^\d+$/u.test(port)) {
            if (port === "80") protocol = "http";

            host = host.slice(0, portIndex);
        }
    }

    return { host, protocol };
}

type SiteBlock = {
    addresses: string[];
    body: string;
};

/**
 * Splits a Caddyfile snippet into site blocks. A line at brace depth zero
 * that ends with `{` starts a block; its remainder is the address list.
 * Ported from stoat-old's compose-caddy site splitter.
 */
function splitSiteBlocks(caddyfile: string): SiteBlock[] {
    const blocks: SiteBlock[] = [];
    let depth = 0;
    let current: SiteBlock | undefined;

    for (const rawLine of caddyfile.split("\n")) {
        const line = rawLine.trim();

        if (line === "" || line.startsWith("#")) continue;

        const opens = line.split("{").length - 1 - (line.split("{{").length - 1) * 2;
        const closes = line.split("}").length - 1 - (line.split("}}").length - 1) * 2;

        if (depth === 0 && line.endsWith("{")) {
            const addressPart = line.slice(0, -1).trim();
            current = {
                addresses: addressPart
                    .split(/[\s,]+/u)
                    .map((address) => address.trim())
                    .filter((address) => address !== ""),
                body: "",
            };
            depth += opens - closes;

            continue;
        }

        if (current) current.body += `${rawLine}\n`;

        depth += opens - closes;

        if (depth <= 0 && current) {
            blocks.push(current);
            current = undefined;
            depth = 0;
        }
    }

    if (current) blocks.push(current);

    return blocks;
}

type UpstreamRoute = {
    containerPort?: number;
    path?: string;
    upstreamService: string;
};

const MATCHER_BLOCK_PATTERN = /^(?:handle_path|handle|route)\s+(?<path>\S+)\s*\{$/u;

function stripMatcherQuotes(token: string): string {
    const quoted =
        token.length >= 2 &&
        ((token.startsWith('"') && token.endsWith('"')) ||
            (token.startsWith("'") && token.endsWith("'")));

    if (quoted) return token.slice(1, -1);

    return token;
}

/**
 * Walks a site block body and pairs every `{{upstreams ...}}` directive with
 * the path matcher of its enclosing handle/handle_path/route block, if any.
 */
function parseUpstreamRoutes(body: string, serviceName: string): UpstreamRoute[] {
    const routes: UpstreamRoute[] = [];
    // Path matcher active at each brace depth (undefined for unmatched blocks).
    const matcherStack: (string | undefined)[] = [];

    for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();

        if (line === "" || line.startsWith("#")) continue;

        const currentPath = matcherStack.findLast((matcher) => matcher !== undefined);

        for (const match of line.matchAll(UPSTREAMS_PATTERN)) {
            const port = match.groups?.port;

            routes.push({
                upstreamService: match.groups?.service ?? serviceName,
                ...(port === undefined ? {} : { containerPort: Number(port) }),
                ...(currentPath === undefined ? {} : { path: currentPath }),
            });
        }

        const opens = line.split("{").length - 1 - (line.split("{{").length - 1) * 2;
        const closes = line.split("}").length - 1 - (line.split("}}").length - 1) * 2;

        if (opens > closes) {
            const rawMatcher = MATCHER_BLOCK_PATTERN.exec(line)?.groups?.path;
            const matcher = rawMatcher === undefined ? undefined : stripMatcherQuotes(rawMatcher);
            matcherStack.push(matcher?.startsWith("/") ? matcher : undefined);

            for (let extra = 1; extra < opens - closes; extra += 1) matcherStack.push(undefined);
        } else if (closes > opens) {
            for (let count = 0; count < closes - opens; count += 1) matcherStack.pop();
        }
    }

    return routes;
}

/** Extracts HTTP(S) routes from a single service's `x-caddy` value. */
export function parseCaddyRoutes(caddyfile: string, serviceName: string): CaddyRoute[] {
    const routes: CaddyRoute[] = [];
    const seen = new Set<string>();

    for (const block of splitSiteBlocks(caddyfile)) {
        const blockRoutes = parseUpstreamRoutes(block.body, serviceName);

        for (const address of block.addresses) {
            // Skip global option blocks and snippet definitions.
            if (address.startsWith("(") || address === "{") continue;

            // Unresolved `${VAR}` hosts cannot map to a route; they are
            // covered by interpolation when the variable is defined.
            if (address.includes("$")) continue;

            const { host, protocol } = parseSiteAddress(address);

            if (host === "" || host === ":") continue;

            const targets: UpstreamRoute[] =
                blockRoutes.length > 0 ? blockRoutes : [{ upstreamService: serviceName }];

            for (const route of targets) {
                const key = [host, route.path, route.upstreamService, route.containerPort].join(
                    "\u0000",
                );

                if (seen.has(key)) continue;

                seen.add(key);
                routes.push({
                    host,
                    protocol,
                    serviceName,
                    upstreamService: route.upstreamService,
                    ...(route.containerPort === undefined
                        ? {}
                        : { containerPort: route.containerPort }),
                    ...(route.path === undefined ? {} : { path: route.path }),
                });
            }
        }
    }

    return routes;
}

type RawServices = Record<string, unknown>;

function readServices(composeText: string): RawServices {
    let parsed: unknown;

    try {
        parsed = YAML.parse(composeText, { merge: true });
    } catch {
        throw new Error("Invalid compose YAML");
    }

    // SAFETY: narrowed with Predicate guards immediately below before field reads.
    const root = parsed as Record<string, unknown> | null;

    if (root === null || !Predicate.isObject(root) || !Predicate.isObject(root.services))
        throw new Error('Compose must contain a "services" map');

    // SAFETY: root.services passed the isObject guard above.
    return root.services as RawServices;
}

/**
 * Parse every service's `x-ports` / `x-caddy` into ingress entries plus issues.
 * Display values (hostnames, ports, routes) are resolved through the
 * resource's Variables (`envText`); entries keep the raw spec for edits.
 */
export function parseIngressCompose(composeText: string, envText = ""): IngressSnapshot {
    const services = readServices(composeText);
    const names = Object.keys(services);
    const entries: IngressEntry[] = [];
    const caddyRoutes: CaddyRoute[] = [];
    const issues: IngressIssue[] = [];
    const seenHostnames = new Map<string, string>();
    const vars = parseEnvText(envText);

    const expand = (value: string): string =>
        interpolateComposeVariables(value, (name) => vars.get(name));

    for (const name of names) {
        const service = services[name];

        if (service === null || service === undefined) continue;

        if (!Predicate.isObject(service)) {
            issues.push({
                service: name,
                message: `Service "${name}" has an invalid configuration.`,
            });

            continue;
        }

        // SAFETY: narrowed with the isObject guard above.
        const record = service as Record<string, unknown>;
        const ports = record["x-ports"];

        if (ports !== undefined) {
            if (!Array.isArray(ports)) {
                issues.push({
                    service: name,
                    message: `Service "${name}" has an invalid x-ports value; use a list.`,
                });
            } else {
                for (const item of ports) {
                    if (Predicate.isString(item)) {
                        const trimmed = item.trim();

                        if (trimmed === "") {
                            issues.push({
                                service: name,
                                message: `Service "${name}" has an empty publish entry.`,
                            });

                            continue;
                        }

                        parsePortSpec(name, expand(trimmed), entries, issues, trimmed);
                    } else if (Predicate.isNumber(item)) {
                        parsePortSpec(name, String(item), entries, issues, String(item));
                    } else {
                        issues.push({
                            service: name,
                            message: `Service "${name}" has an invalid publish entry; use "[hostname:]port[/protocol]" or host mode with @host.`,
                        });
                    }
                }
            }
        }

        const caddy = record["x-caddy"];

        if (caddy !== undefined) {
            if (!Predicate.isString(caddy)) {
                issues.push({
                    service: name,
                    message: `Service "${name}" has an invalid x-caddy value; use a Caddyfile string.`,
                });
            } else if (caddy.trim() === "") {
                issues.push({
                    service: name,
                    message: `Service "${name}" has an empty x-caddy value.`,
                });
            } else {
                entries.push({
                    kind: "caddy",
                    service: name,
                    caddy,
                    fileRef: isCaddyFileRef(caddy),
                });

                if (!isCaddyFileRef(caddy))
                    caddyRoutes.push(...parseCaddyRoutes(expand(caddy), name));
            }
        }
    }

    for (const entry of entries) {
        if (entry.kind !== "http" || entry.hostname === null) continue;

        const key = entry.hostname.toLowerCase();
        const first = seenHostnames.get(key);

        if (first !== undefined) {
            issues.push({
                service: entry.service,
                message: `Hostname "${entry.hostname}" is published more than once; Caddy skips the conflicting config.`,
            });
        } else {
            seenHostnames.set(key, entry.service);
        }
    }

    for (const name of names) {
        let hasCaddy = false;
        let hasHttp = false;

        for (const entry of entries) {
            if (entry.service !== name) continue;

            if (entry.kind === "caddy") hasCaddy = true;

            if (entry.kind === "http") hasHttp = true;
        }

        if (hasCaddy && hasHttp) {
            issues.push({
                service: name,
                message: `Service "${name}" uses x-caddy and cannot also publish http/https ports in x-ports.`,
            });
        }
    }

    return { services: names, entries, caddyRoutes, issues };
}

/** Service names in file order. Throws on invalid YAML or a missing services map. */
export function listComposeServices(composeText: string): string[] {
    return parseIngressCompose(composeText).services;
}

/** Canonical `[hostname:]container_port/protocol` spec. */
export function buildHttpSpec(
    hostname: string | null,
    containerPort: number,
    protocol: HttpProtocol,
): string {
    return `${hostname ? `${hostname}:` : ""}${containerPort}/${protocol}`;
}

/** Canonical `[bind:]host_port:container_port/protocol@host` spec. */
export function buildHostSpec(
    bind: string | null,
    hostPort: number,
    containerPort: number,
    protocol: HostProtocol,
): string {
    return `${bind ? `${bind}:` : ""}${hostPort}:${containerPort}/${protocol}@host`;
}

function openDocument(composeText: string): Document {
    const doc = YAML.parseDocument(composeText);

    if (doc.errors.length > 0) throw new Error("Invalid compose YAML");

    return doc;
}

function serviceMap(doc: Document): YAMLMap {
    const services = doc.get("services", true);

    if (!isMap(services)) throw new Error('Compose must contain a "services" map');

    return services;
}

function findService(map: YAMLMap, serviceName: string): YAMLMap {
    for (const pair of map.items) {
        const key = pair.key;

        if (isScalar(key) && Predicate.isString(key.value) && key.value === serviceName) {
            if (!isMap(pair.value))
                throw new Error(`Service "${serviceName}" has no configuration mapping.`);

            return pair.value;
        }
    }

    throw new Error(`Service "${serviceName}" not found in the Compose file.`);
}

/** Append a raw `x-ports` entry to a service, preserving YAML comments. */
export function addIngressToCompose(
    composeText: string,
    serviceName: string,
    spec: string,
): string {
    const trimmed = spec.trim();

    if (trimmed === "") throw new Error("Publish entry must not be empty.");

    const doc = openDocument(composeText);
    const service = findService(serviceMap(doc), serviceName);
    const ports = service.get("x-ports", true);

    if (ports === undefined || ports === null) {
        service.set("x-ports", doc.createNode([trimmed]));

        return doc.toString();
    }

    if (!isSeq(ports)) throw new Error(`Service "${serviceName}" has an invalid x-ports value.`);

    for (const item of ports.items) {
        if (!isScalar(item)) continue;

        const value = Predicate.isString(item.value) ? item.value : null;
        const numeric = Predicate.isNumber(item.value) ? String(item.value) : null;

        if (value === trimmed || numeric === trimmed)
            throw new Error(`That publish entry already exists on service "${serviceName}".`);
    }

    ports.add(doc.createNode(trimmed));

    return doc.toString();
}

/** Remove one raw `x-ports` entry; drops the key when the list becomes empty. */
export function removeIngressFromCompose(
    composeText: string,
    serviceName: string,
    raw: string,
): string {
    const doc = openDocument(composeText);
    const service = findService(serviceMap(doc), serviceName);
    const ports = service.get("x-ports", true);

    if (!isSeq(ports)) throw new Error(`Service "${serviceName}" has no publish entries.`);

    const kept = ports.items.filter((item) => !(isScalar(item) && String(item.value) === raw));

    if (kept.length === ports.items.length)
        throw new Error(`Publish entry not found on service "${serviceName}".`);

    if (kept.length === 0) {
        service.delete("x-ports");
    } else {
        ports.items.splice(0, ports.items.length, ...kept);
    }

    return doc.toString();
}

/** Set a service's `x-caddy` Caddyfile, preserving the rest of the YAML. */
export function setServiceCaddy(
    composeText: string,
    serviceName: string,
    caddyText: string,
): string {
    if (caddyText.trim() === "") throw new Error("Caddy config must not be empty.");

    const doc = openDocument(composeText);
    const service = findService(serviceMap(doc), serviceName);
    const node = doc.createNode(caddyText);

    if (isScalar(node) && caddyText.includes("\n")) node.type = Scalar.BLOCK_LITERAL;

    service.set("x-caddy", node);

    return doc.toString();
}

/** Remove a service's `x-caddy` key. */
export function removeServiceCaddy(composeText: string, serviceName: string): string {
    const doc = openDocument(composeText);
    const service = findService(serviceMap(doc), serviceName);

    if (!service.has("x-caddy")) throw new Error(`Service "${serviceName}" has no x-caddy config.`);

    service.delete("x-caddy");

    return doc.toString();
}
