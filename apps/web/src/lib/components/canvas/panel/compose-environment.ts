import * as v from "valibot";
import { formatEnvValue, parseAllAssignments, parseEnvLines } from "@stoat/workflows/env-lines";
import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";

const scalar = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

const composeSchema = v.object({
    services: v.fallback(
        v.record(
            v.string(),
            v.object({
                environment: v.fallback(
                    v.union([v.array(v.string()), v.record(v.string(), v.nullable(scalar))]),
                    [],
                ),
            }),
        ),
        {},
    ),
});

/** Every Compose service's name, whether or not it sets `environment`. */
export function composeServiceNames(compose: string) {
    try {
        return new Set(Object.keys(v.parse(composeSchema, parse(compose)).services));
    } catch {
        return new Set<string>();
    }
}

/** The `environment` entries each Compose service sets itself; pass-through keys without a value are left out. */
export function composeEnvironment(compose: string) {
    let services: v.InferOutput<typeof composeSchema>["services"] = {};

    try {
        services = v.parse(composeSchema, parse(compose)).services;
    } catch {
        // An unparsable draft just has no Compose variables to show.
    }

    return Object.entries(services).flatMap(([service, { environment }]) => {
        const entries = Array.isArray(environment)
            ? environment.flatMap((item) => {
                  const split = item.indexOf("=");

                  return split === -1 ? [] : [[item.slice(0, split), item.slice(split + 1)]];
              })
            : Object.entries(environment).flatMap(([key, value]) =>
                  value === null ? [] : [[key, value]],
              );

        return entries.map(([key = "", value = ""]) => ({ service, key, value }));
    });
}

/** Sets one service's `environment` value in place, or removes the entry when `value` is undefined. */
export function setComposeEnvironment(
    compose: string,
    service: string,
    key: string,
    value: string | undefined,
) {
    const document = parseDocument(compose);
    const environment = document.getIn(["services", service, "environment"], true);

    if (isSeq(environment)) {
        const index = environment.items.findIndex(
            (item) => isScalar(item) && String(item.value).startsWith(`${key}=`),
        );

        const item = environment.items[index];

        if (value === undefined) environment.delete(index);
        else if (isScalar(item)) item.value = `${key}=${value}`;
        else environment.add(`${key}=${value}`);
    } else if (isMap(environment)) {
        const node = environment.get(key, true);

        if (value === undefined) environment.delete(key);
        else if (isScalar(node)) node.value = value;
        else environment.set(key, value);
    } else if (value !== undefined && document.hasIn(["services", service])) {
        document.setIn(["services", service, "environment", key], value);
    }

    return document.toString();
}

const sectionHeader = /^# \[([^\]]+)\]$/u;

/** The Compose variables as raw-editor sections: a `# [service]` header, then `.env` lines. */
export function composeEnvironmentSections(compose: string) {
    const services = Map.groupBy(composeEnvironment(compose), (variable) => variable.service);

    return [...services]
        .map(([service, variables]) =>
            [
                `# [${service}]`,
                ...variables.map(({ key, value }) => `${key}=${formatEnvValue(value)}`),
            ].join("\n"),
        )
        .join("\n\n");
}

/**
 * Splits raw-editor text into the Variables `.env` (before the first header) and each service's
 * section. Only a `# [service]` naming one of `services` is a header, and never a line inside a
 * quoted multi-line value, so `.env` comments like `# [secrets]` stay Variables. Throws on a
 * header after the first that names no service, or one service twice, instead of guessing.
 */
export function splitRawEnvironment(text: string, services: ReadonlySet<string>) {
    const lines = text.split("\n");

    const quoted = new Set(
        parseAllAssignments(text).flatMap(({ start, end }) =>
            Array.from({ length: end - start }, (_, index) => start + index + 1),
        ),
    );

    const headerAt = (index: number) =>
        quoted.has(index) ? undefined : sectionHeader.exec(lines[index] ?? "")?.[1];

    const first = lines.findIndex((_, index) => {
        const header = headerAt(index);

        return header !== undefined && services.has(header);
    });

    const sections = new Map<string, string>();

    let service = "";

    for (let index = Math.max(first, 0); first !== -1 && index < lines.length; index += 1) {
        const header = headerAt(index);

        if (header === undefined) {
            sections.set(service, `${sections.get(service) ?? ""}${lines[index]}\n`);
            continue;
        }

        if (!services.has(header))
            throw new Error(
                `"# [${header}]" names no Compose service. Rename or remove that line.`,
            );

        if (sections.has(header))
            throw new Error(`"# [${header}]" appears twice. Merge its variables under one header.`);

        service = header;
        sections.set(service, "");
    }

    const env = first === -1 ? text : lines.slice(0, first).join("\n");

    return { env: env.trimEnd() ? `${env.trimEnd()}\n` : "", sections };
}

/** Rewrites the Compose `environment` entries to match the raw-editor sections; a dropped section clears its service. */
export function applyComposeSections(compose: string, sections: Map<string, string>) {
    const current = composeEnvironment(compose);

    let next = compose;

    for (const { service, key } of current) {
        const kept = parseEnvLines(sections.get(service) ?? "").some(
            (variable) => variable.key === key,
        );

        if (!kept) next = setComposeEnvironment(next, service, key, undefined);
    }

    for (const [service, text] of sections) {
        for (const { key, value } of parseEnvLines(text)) {
            const existing = current.find(
                (variable) => variable.service === service && variable.key === key,
            );

            if (existing?.value !== value) next = setComposeEnvironment(next, service, key, value);
        }
    }

    return next;
}
