import * as v from "valibot";
import YAML from "yaml";

export {
    composeConfigFiles,
    formatComposeFile,
    resourceComposePrefix,
    resourceEnv,
    rewriteComposeHostname,
    unformatComposeFile,
    type FormattedCompose,
} from "@stoat/workflows/compose";

// Long-syntax ports are normalized to the short `[host_ip:]published:target/protocol` form.
const portSchema = v.union([
    v.string(),
    v.pipe(v.number(), v.transform(String)),
    v.pipe(
        v.object({
            target: v.number(),
            published: v.optional(v.union([v.string(), v.number()]), ""),
            protocol: v.optional(v.string(), "tcp"),
            host_ip: v.optional(v.string()),
        }),
        v.transform(
            ({ host_ip, published, target, protocol }) =>
                `${host_ip ? `${host_ip}:` : ""}${published}:${target}/${protocol}`,
        ),
    ),
]);

const composeSchema = v.object({
    services: v.record(
        v.string(),
        v.nullish(
            v.object({
                ports: v.optional(v.array(portSchema), []),
                "x-ports": v.optional(v.array(v.string()), []),
            }),
        ),
    ),
});

// ponytail: port ranges and IPv6 host IPs are skipped.
function publishedTcpPort(spec: string, uncloud: boolean) {
    // Uncloud x-ports without `@host` are HTTP(S) ingress, not raw TCP.
    if (uncloud && !spec.endsWith("@host")) return [];

    const [ports = "", protocol = "tcp"] = spec.replace(/@host$/u, "").split("/");
    const parts = ports.split(":");
    const port = Number(parts.at(-2));
    const host = parts.at(-3);

    if (protocol !== "tcp" || !Number.isInteger(port) || port < 1) return [];

    return [{ target: Number(parts.at(-1)), port, host: host === "0.0.0.0" ? undefined : host }];
}

/** First Compose service, and the TCP port it publishes for PostgreSQL. */
export function postgresService(compose: string) {
    const [name, service] =
        Object.entries(v.parse(composeSchema, YAML.parse(compose)).services)[0] ?? [];

    if (!name) return;

    const ports = [
        ...(service?.ports ?? []).flatMap((spec) => publishedTcpPort(spec, false)),
        ...(service?.["x-ports"] ?? []).flatMap((spec) => publishedTcpPort(spec, true)),
    ];

    return { name, published: ports.find((port) => port.target === 5432) };
}

/** Reserve published ports across every service, including ranges and IPv6 bindings. */
export function composePublishedPorts(compose: string): number[] {
    const services = v.parse(composeSchema, YAML.parse(compose)).services;

    return Object.values(services).flatMap((service) =>
        [...(service?.ports ?? []), ...(service?.["x-ports"] ?? [])].flatMap(publishedPortNumbers),
    );
}

export function publishedPortNumbers(spec: string): number[] {
    // The published port is always the penultimate colon-delimited segment.
    const published = spec
        .replace(/\/(?:tcp|udp|http|https)(?:@host)?$/u, "")
        .split(":")
        .at(-2);

    if (!published) return [];

    // Ingress hostnames (without a load-balancer port) do not reserve a numeric host port.
    if (/\/https?$/u.test(spec) && !/^\d/u.test(published)) return [];
    const match = /^(\d+)(?:-(\d+))?$/u.exec(published);

    if (!match)
        throw new Error("Resolve published port variables before enabling external access.");
    const first = Number(match[1]);
    const last = Number(match[2] ?? first);

    if (first < 1 || last > 65535 || last < first) throw new Error("Invalid published port range.");

    return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** Edit YAML nodes instead of reserializing objects, retaining comments and other settings. */
export function enablePostgresPort(compose: string, occupied: Set<number>): string {
    const service = postgresService(compose);

    if (!service) throw new Error("The Compose draft has no PostgreSQL service.");

    if (service.published) return compose;
    let port = 15432;

    while (port <= 65535 && occupied.has(port)) port++;

    if (port > 65535) throw new Error("No unused external TCP port is available.");
    const document = YAML.parseDocument(compose);
    const path = ["services", service.name];
    const usesStandardPorts = document.hasIn([...path, "ports"]);
    const key = usesStandardPorts ? "ports" : "x-ports";
    const portsPath = [...path, key];

    if (!document.hasIn(portsPath)) document.setIn(portsPath, document.createNode([]));
    document.addIn(
        portsPath,
        usesStandardPorts
            ? { target: 5432, published: port, protocol: "tcp", mode: "host" }
            : `${port}:5432/tcp@host`,
    );

    return document.toString();
}
