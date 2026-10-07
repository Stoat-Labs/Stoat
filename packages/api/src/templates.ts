import { randomBytes, randomUUID } from "node:crypto";
import * as v from "valibot";
import YAML from "yaml";
import { databaseEngines } from "./databases";

// Bundled at build time: adding a template needs a rebuild, but there is no runtime
// filesystem access, so app ids and versions can never escape the templates folder.
const files = import.meta.glob<string>(
    [
        "../../../templates/*/manifest.json",
        "../../../templates/*/versions/*/{compose.yaml,compose.yml,.env}",
    ],
    // `exhaustive` makes the glob include dotfiles (`.env`).
    { eager: true, exhaustive: true, query: "?raw", import: "default" },
);

const logos = import.meta.glob<string>("../../../templates/*/logo.{svg,png}", {
    eager: true,
    query: "?inline",
    import: "default",
});

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";

const PATH = new RegExp(`/templates/(${SEGMENT})/(?:versions/(${SEGMENT})/)?([^/]+)$`, "u");

const manifestSchema = v.intersect([
    v.object({
        name: v.pipe(v.string(), v.trim(), v.minLength(1)),
        description: v.pipe(v.string(), v.trim(), v.minLength(1)),
        icon: v.optional(v.pipe(v.string(), v.regex(new RegExp(`^${SEGMENT}$`, "u")))),
        tags: v.optional(v.array(v.string()), []),
    }),
    // Database templates name their engine; it is stored in the resource's `settings.engine`.
    v.variant("type", [
        v.object({ type: v.literal("compose") }),
        v.object({ type: v.literal("database"), engine: v.picklist(databaseEngines) }),
    ]),
]);

export interface TemplateVersion {
    compose: string;
    env: string;
}

export type Template = v.InferOutput<typeof manifestSchema> & {
    appId: string;
    logo: string | null;
    versions: Record<string, TemplateVersion>;
};

function loadTemplates() {
    const apps = new Map<
        string,
        { manifest?: string; logo?: string; versions: Record<string, Partial<TemplateVersion>> }
    >();

    const app = (id: string) => apps.get(id) ?? apps.set(id, { versions: {} }).get(id)!;

    for (const [path, content] of Object.entries(files)) {
        const [, appId, version, file] = PATH.exec(path) ?? [];

        if (!appId || !file) continue;

        if (!version) {
            app(appId).manifest = content;
            continue;
        }

        const entry = (app(appId).versions[version] ??= {});

        if (file === ".env") entry.env = content;
        else entry.compose ??= content;
    }

    for (const [path, logo] of Object.entries(logos)) {
        const [, appId, , file] = PATH.exec(path) ?? [];

        // Prefer logo.svg over logo.png.
        if (appId && (file === "logo.svg" || !app(appId).logo)) app(appId).logo = logo;
    }

    const templates: Template[] = [];

    for (const [appId, { manifest, logo, versions }] of apps) {
        const parsed = v.safeParse(manifestSchema, JSON.parse(manifest ?? "null"));

        const valid = Object.entries(versions).flatMap(([version, { compose, env }]) =>
            compose ? [[version, { compose, env: env ?? "" }] as const] : [],
        );

        if (!parsed.success || valid.length === 0) continue;

        templates.push({
            ...parsed.output,
            appId,
            logo:
                logo ??
                (parsed.output.icon ? `https://api.svgl.app/svg/${parsed.output.icon}.svg` : null),
            versions: Object.fromEntries(valid),
        });
    }

    return templates.toSorted((a, b) => a.name.localeCompare(b.name));
}

export const templates = loadTemplates();

const volumeSchema = v.union([
    v.pipe(
        v.string(),
        v.transform((spec) => {
            const [source = "", target] = spec.split(":");

            return target ? { source, target } : { source: null, target: source };
        }),
    ),
    v.object({ source: v.optional(v.string(), ""), target: v.string() }),
]);

const summarySchema = v.object({
    services: v.record(
        v.string(),
        v.nullish(
            v.object({
                image: v.optional(v.string()),
                volumes: v.optional(v.array(volumeSchema), []),
            }),
        ),
    ),
});

/** Services (with image and volume mounts) and the env keys a template version generates secrets for. */
export function summarizeVersion({ compose, env }: TemplateVersion) {
    const { services } = v.parse(summarySchema, YAML.parse(compose));

    return {
        services: Object.entries(services).map(([name, service]) => ({
            name,
            image: service?.image ?? null,
            volumes: (service?.volumes ?? []).map(({ source, target }) => ({
                source: source || null,
                target,
            })),
        })),
        secrets: env
            .split("\n")
            .flatMap((line) => /^\s*([\w.-]+)\s*=.*\{\{.+\}\}/u.exec(line)?.slice(1, 2) ?? []),
        required: requiredVariables(env),
    };
}

// `KEY=` with no value marks a variable the user must fill in before deploying.
const REQUIRED = /^[ \t]*([\w.-]+)[ \t]*=[ \t]*$/gmu;

export function requiredVariables(env: string) {
    return Array.from(env.matchAll(REQUIRED), ([, key = ""]) => key);
}

/** Fill every `KEY=` line with the user's value, quoted so `parseEnv` keeps `#` and spaces. */
export function fillVariables(env: string, values: Record<string, string>) {
    return env.replaceAll(REQUIRED, (line, key: string) => {
        const value = values[key];
        const quote = ["'", '"', "`"].find((q) => !value?.includes(q));

        if (value === undefined || !quote || /[\r\n]/u.test(value)) return line;

        // Compose interpolation runs on .env values; `$$` keeps a literal `$`.
        return `${key}=${quote}${value.replaceAll("$", () => "$$")}${quote}`;
    });
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Replace every `{{ UUID }}` / `{{ N }}` placeholder with a fresh random value, and `{{ DNS }}` with the cluster domain. */
export function expandSecrets(text: string, domain?: string): string {
    return text.replaceAll(/\{\{\s*(UUID|DNS|\d+)\s*\}\}/giu, (placeholder, token: string) => {
        if (token.toUpperCase() === "UUID") return randomUUID();

        if (token.toUpperCase() === "DNS") {
            if (!domain) throw new Error("This cluster has no reserved domain for {{ DNS }}.");

            return domain;
        }

        const length = Number(token);

        if (length < 1 || length > 256)
            throw new Error(`Invalid secret placeholder ${placeholder}.`);

        // 256 is a multiple of 64, so `byte % 64` stays uniform.
        return Array.from(randomBytes(length), (byte) => BASE64[byte % 64]).join("");
    });
}
