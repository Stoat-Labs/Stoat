import { parseIngressCompose } from "@stoat/workflows/ingress";
import { referencedResourceIds } from "@stoat/workflows/references";
import * as v from "valibot";
import YAML from "yaml";

import { resourceEnv } from "./compose";
import type { Template } from "./templates";

// Named volumes only; bind mounts (`./data`, `/srv`) and anonymous volumes are not shown.
const NAMED_VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

const volumeSchema = v.union([
    v.pipe(
        v.string(),
        v.transform((volume) => {
            const [source = ""] = volume.split(":");

            // A single segment is an anonymous volume's container path.
            return volume.includes(":") && NAMED_VOLUME.test(source) ? [source] : [];
        }),
    ),
    v.pipe(
        v.object({ type: v.optional(v.string(), "volume"), source: v.optional(v.string()) }),
        v.transform(({ type, source }) => (type === "volume" && source ? [source] : [])),
    ),
]);

const serviceSchema = v.nullish(
    v.object({
        // Display only: `${VAR:-default}` shows its default, so `${DB_IMAGE:-mariadb}` reads as mariadb.
        image: v.optional(
            v.pipe(
                v.string(),
                v.transform((image) =>
                    image.replaceAll(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/gu, "$1"),
                ),
            ),
        ),
        // `depends_on` is either a list of names or a map of name to condition.
        depends_on: v.optional(
            v.union([
                v.array(v.string()),
                v.pipe(v.record(v.string(), v.unknown()), v.transform(Object.keys)),
            ]),
            [],
        ),
        volumes: v.optional(v.array(volumeSchema), []),
    }),
);

const composeSchema = v.object({
    services: v.record(v.string(), serviceSchema),
});

export type GraphService = {
    name: string;
    image: string | undefined;
    /** App id of the bundled template whose logo fits this image. */
    template: string | undefined;
    /** Public HTTP hostnames from `x-ports`, shown under the name like Railway's domains. */
    domains: string[];
    dependsOn: string[];
    volumes: string[];
};

export type GraphResourceInput = {
    id: string;
    spec: string | null;
    draftSpec: string | null;
    settings: unknown;
};

type GraphTemplate = Pick<Template, "appId" | "logo" | "versions">;

/** Last path segment without registry, tag or digest: `ghcr.io/org/app:1.0` is `app`. */
function imageRepository(image: string | undefined) {
    return image
        ?.split("@")[0]
        ?.replace(/:[^/]*$/u, "")
        .split("/")
        .at(-1)
        ?.toLowerCase();
}

/** Compose services with their in-stack dependencies and named volumes. */
export function composeServices(compose: string) {
    const { services } = v.parse(composeSchema, YAML.parse(compose));
    const names = new Set(Object.keys(services));

    return Object.entries(services).map(([name, service]) => ({
        name,
        image: service?.image,
        // Dependencies on undeclared services are a Compose error, not an edge.
        dependsOn: (service?.depends_on ?? []).filter((dependency) => names.has(dependency)),
        volumes: (service?.volumes ?? []).flat(),
    }));
}

/**
 * Image repository to template app id, for images a template runs under its own name
 * (`seafileltd/seafile-pro-mc` is Seafile, `postgres` is PostgreSQL). Helper images such as
 * Seafile's bundled MariaDB never borrow the Seafile logo.
 */
function templateImages(templates: GraphTemplate[]) {
    const images = new Map<string, string>();

    for (const template of templates) {
        if (!template.logo) continue;

        for (const { compose } of Object.values(template.versions)) {
            let services: ReturnType<typeof composeServices> = [];

            try {
                services = composeServices(compose);
            } catch {
                continue;
            }

            for (const service of services) {
                const repository = imageRepository(service.image);

                if (
                    repository &&
                    !images.has(repository) &&
                    (repository.startsWith(template.appId) || template.appId.startsWith(repository))
                )
                    images.set(repository, template.appId);
            }
        }
    }

    return images;
}

/** Hostnames each service publishes; `.env` fills in `${VAR}` hostnames. */
function serviceDomains(compose: string, row: GraphResourceInput) {
    const domains = new Map<string, string[]>();
    let env = "";

    try {
        env = resourceEnv(row);
    } catch {
        // Without the `.env`, variable hostnames simply stay unresolved.
    }

    for (const entry of parseIngressCompose(compose, env).entries) {
        if (entry.kind !== "http" || !entry.hostname) continue;

        domains.set(entry.service, [...(domains.get(entry.service) ?? []), entry.hostname]);
    }

    return domains;
}

/**
 * Services and same-project references for each resource on the project canvas.
 * The deployed spec wins over the draft, and a broken spec never fails the whole graph.
 * Logos are sent once per template rather than once per service.
 */
export function buildProjectGraph(rows: GraphResourceInput[], templates: GraphTemplate[]) {
    const ids = new Set(rows.map((row) => row.id));
    const images = templateImages(templates);
    const logos: Record<string, string> = {};

    const resources = rows.map((row) => {
        const compose = row.spec?.trim() ? row.spec : row.draftSpec?.trim() ? row.draftSpec : null;
        let services: GraphService[] = [];
        let parseError = false;

        if (compose) {
            try {
                const domains = serviceDomains(compose, row);

                services = composeServices(compose).map((service) => ({
                    ...service,
                    template: images.get(imageRepository(service.image) ?? ""),
                    domains: domains.get(service.name) ?? [],
                }));
            } catch {
                parseError = true;
            }
        }

        for (const { template } of services) {
            const logo = templates.find((entry) => entry.appId === template)?.logo;

            if (template && logo) logos[template] = logo;
        }

        let references: string[] = [];

        try {
            references = referencedResourceIds(resourceEnv(row)).filter(
                (id) => id !== row.id && ids.has(id),
            );
        } catch {
            // Unparseable `.env` contributes no edges; the Variables page reports it.
        }

        return {
            id: row.id,
            draftOnly: !row.spec?.trim() && compose !== null,
            parseError,
            services,
            references,
        };
    });

    return { resources, logos };
}
