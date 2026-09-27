import * as v from "valibot";
import YAML from "yaml";

export {
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

/** First Compose service, and the TCP port it publishes for 5432 (or its first published TCP port). */
export function postgresService(compose: string) {
    const [name, service] =
        Object.entries(v.parse(composeSchema, YAML.parse(compose)).services)[0] ?? [];

    if (!name) return;

    const ports = [
        ...(service?.ports ?? []).flatMap((spec) => publishedTcpPort(spec, false)),
        ...(service?.["x-ports"] ?? []).flatMap((spec) => publishedTcpPort(spec, true)),
    ];

    return { name, published: ports.find((port) => port.target === 5432) ?? ports[0] };
}
