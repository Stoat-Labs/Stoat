import { parseIngressCompose } from "@stoat/workflows/ingress";
import { referencedResourceIds } from "@stoat/workflows/references";
import * as v from "valibot";
import YAML from "yaml";

import { internalHostname, resourceComposePrefix, resourceEnv } from "./compose";
import { NAMED_VOLUME, volumeMounts } from "./compose-volumes";
import type { Template } from "./templates";

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
    volumes: v.nullish(v.record(v.string(), v.unknown())),
});

export type GraphVolume = {
    name: string;
    /** Services that mount it; none once they are removed or disconnected, but it stays declared. */
    services: string[];
    /** Where each of them mounts it. */
    mounts: { service: string; target: string }[];
};

export type GraphService = {
    name: string;
    image: string | undefined;
    /** In the draft but not in the deployed spec, e.g. just moved here. */
    isNew: boolean;
    /** App id of the bundled template whose logo fits this image. */
    template: string | undefined;
    /** Public HTTP hostnames from `x-ports`, shown under the name like Railway's domains. */
    domains: string[];
    /** Cluster DNS name of the deployed service; null until it is deployed. */
    internalHostname: string | null;
    dependsOn: string[];
    volumes: string[];
};

export type GraphResourceInput = {
    id: string;
    slug: string;
    projectId: string;
    spec: string | null;
    draftSpec: string | null;
    /** Staged for deletion: the next apply removes the whole resource. */
    pendingDelete?: boolean;
    settings: unknown;
    /** The `.env` and name prefix of the latest successful deploy; null if it never deployed. */
    deployed: { env: string; prefix: string } | null;
    /**
     * The Compose, `.env` and prefix of the latest deploy that was not cancelled, even if it is
     * still running or failed: those changes were already shipped. Null if there is none.
     * `failed` means it stopped before finishing, so the services it should have removed may
     * still be running.
     */
    attempted: { spec: string; env: string; prefix: string; failed: boolean } | null;
};

type GraphTemplate = Pick<Template, "appId" | "logo"> & {
    versions: Record<string, { compose: string }>;
};

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
        // One entry per volume, even when a service mounts it at several paths.
        volumes: [...new Set((service?.volumes ?? []).flat())],
    }));
}

/** Declared volumes of a Compose file, plus any a service mounts without declaring. */
export function composeVolumes(compose: string): GraphVolume[] {
    const { volumes } = v.parse(composeSchema, YAML.parse(compose));

    const mounted = new Map<string, GraphVolume["mounts"]>(
        Object.keys(volumes ?? {}).map((name) => [name, []]),
    );

    for (const { volume, service, target } of volumeMounts(compose))
        mounted.set(volume, [...(mounted.get(volume) ?? []), { service, target }]);

    return [...mounted].map(([name, mounts]) => ({
        name,
        services: mounts.map((mount) => mount.service),
        mounts,
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

/** The template app an image runs, matched like the canvas does, for logos shown elsewhere. */
export function templateMatcher(templates: GraphTemplate[]) {
    const images = templateImages(templates);

    return (image: string | null) => images.get(imageRepository(image ?? undefined) ?? "") ?? null;
}

/** Service names of the deployed spec, or undefined when nothing was deployed or it can't be read. */
// An unreadable `.env` compares as empty; the Variables page reports the error itself.
function safeEnv(row: GraphResourceInput) {
    try {
        return resourceEnv(row);
    } catch {
        return "";
    }
}

function deployedServiceNames(spec: string | null) {
    if (!spec?.trim()) return undefined;

    try {
        return new Set(composeServices(spec).map((service) => service.name));
    } catch {
        return undefined;
    }
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
        // The canvas shows staged edits, like Railway: the draft wins, and what changed is flagged.
        const compose = row.draftSpec?.trim() ? row.draftSpec : row.spec?.trim() ? row.spec : null;
        const deployed = deployedServiceNames(row.spec);
        let services: GraphService[] = [];
        let volumes: GraphVolume[] = [];
        let parseError = false;

        if (compose) {
            try {
                const domains = serviceDomains(compose, row);

                services = composeServices(compose).map((service) => ({
                    ...service,
                    isNew: deployed !== undefined && !deployed.has(service.name),
                    template: images.get(imageRepository(service.image) ?? ""),
                    domains: domains.get(service.name) ?? [],
                    // Named with the deployed prefix, since that is what runs on the cluster.
                    internalHostname:
                        row.deployed && deployed?.has(service.name)
                            ? internalHostname(service.name, row.deployed.prefix || undefined)
                            : null,
                }));
                volumes = composeVolumes(compose);
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

        const draftOnly = !row.spec?.trim() && compose !== null;

        // A different prefix renames every service, so the next deploy replaces all of them.
        const prefixChanged =
            row.deployed !== null && row.deployed.prefix !== (resourceComposePrefix(row) ?? "");

        const kept = new Set(services.map((service) => service.name));

        const removed = [...(deployed ?? [])].filter(
            (name) => row.pendingDelete || prefixChanged || !kept.has(name),
        );

        // Like Railway, deploying commits staged changes: a queued, running or failed deploy
        // reports on its card, and only edits made after it count as staged again.
        // A failed deploy may not have removed its services yet, which would leave the old ones
        // running (a moved service next to its new copy), so those stay staged until one succeeds.
        const changed =
            row.pendingDelete ||
            (row.attempted
                ? row.draftSpec !== row.attempted.spec ||
                  safeEnv(row) !== row.attempted.env ||
                  (resourceComposePrefix(row) ?? "") !== row.attempted.prefix ||
                  (row.attempted.failed && removed.length > 0)
                : draftOnly ||
                  Boolean(
                      row.spec?.trim() && row.draftSpec?.trim() && row.draftSpec !== row.spec,
                  ) ||
                  (row.deployed !== null && row.deployed.env !== safeEnv(row)) ||
                  prefixChanged);

        return {
            id: row.id,
            draftOnly,
            pendingDelete: row.pendingDelete ?? false,
            // Anything the next deploy would change: a first deploy, Compose edits, variables,
            // or the prefix setting.
            changed,
            // Running services the next deploy stops and removes (their volumes stay).
            removed,
            parseError,
            services,
            volumes,
            references,
        };
    });

    return { resources, logos };
}
