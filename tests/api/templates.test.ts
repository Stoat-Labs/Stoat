import { parseEnv } from "node:util";
import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";
import { postgresService } from "../../packages/api/src/compose";
import { databaseEngines } from "../../packages/api/src/databases";
import {
    expandSecrets,
    fillVariables,
    requiredVariables,
    summarizeVersion,
    templates,
} from "../../packages/api/src/templates";
import { formatComposeFile, interpolateCompose } from "../../packages/workflows/src/compose";

const renderedSchema = v.object({
    services: v.record(
        v.string(),
        v.looseObject({
            healthcheck: v.optional(v.looseObject({ test: v.array(v.string()) })),
            depends_on: v.optional(
                v.record(v.string(), v.object({ condition: v.optional(v.string()) })),
            ),
        }),
    ),
});

describe("templates", () => {
    it("loads the postgresql template", () => {
        const postgres = templates.find((template) => template.appId === "postgresql");

        expect(postgres).toMatchObject({
            name: "PostgreSQL",
            type: "database",
            engine: "postgresql",
        });
        expect(postgres?.logo).toMatch(/^data:image\/svg\+xml/u);
        expect(postgres?.versions["18"]?.compose).toContain("postgres:18");
        expect(postgres?.versions["18"]?.env).toContain("POSTGRES_PASSWORD={{ 32 }}");
    });

    it("loads every bundled template and summarizes it", () => {
        const seafile = templates.find((template) => template.appId === "seafile");

        expect(seafile?.logo).toMatch(/^data:image\/svg\+xml/u);
        expect(templates.map(({ appId }) => appId)).toEqual(
            expect.arrayContaining(["jellyfin", "postgresql", "seafile"]),
        );

        for (const template of templates) {
            for (const version of Object.values(template.versions)) summarizeVersion(version);
        }
    });

    it("bundles a database template for every engine", () => {
        const engines = templates.flatMap((template) =>
            template.type === "database" ? [template.engine] : [],
        );

        expect(engines.toSorted()).toEqual([...databaseEngines].toSorted());
    });

    it("points the postgresql metrics exporter at the prefixed database service", () => {
        const version = templates.find(({ appId }) => appId === "postgresql")?.versions["18"];
        const env = expandSecrets(version!.env, "abc.uncld.dev");

        const out = YAML.parse(
            formatComposeFile(
                interpolateCompose(version!.compose, env, "a1b2c3d4-e5f6a7b8", "abc.uncld.dev"),
                "a1b2c3d4-e5f6a7b8",
            ).yaml,
        );

        // Cluster monitoring discovers exporters by the `-metrics` service name suffix.
        expect(Object.keys(out.services)).toEqual([
            "a1b2c3d4-e5f6a7b8-postgres",
            "a1b2c3d4-e5f6a7b8-postgres-metrics",
        ]);
        const database = out.services["a1b2c3d4-e5f6a7b8-postgres"].environment;

        expect(out.services["a1b2c3d4-e5f6a7b8-postgres-metrics"].environment).toEqual({
            DATA_SOURCE_URI: "a1b2c3d4-e5f6a7b8-postgres.internal:5432/app?sslmode=disable",
            // Same credentials the database is created with, after the same hostname rewrite.
            DATA_SOURCE_USER: database.POSTGRES_USER,
            DATA_SOURCE_PASS: database.POSTGRES_PASSWORD,
        });
    });

    it("renders the jellyfin template with prefixed volumes and the cluster domain", () => {
        const version = templates.find(({ appId }) => appId === "jellyfin")?.versions.latest;

        expect(version && summarizeVersion(version).required).toEqual([]);

        const out = formatComposeFile(
            interpolateCompose(
                version!.compose,
                version!.env,
                "a1b2c3d4-e5f6a7b8",
                "abc.uncld.dev",
            ),
            "a1b2c3d4-e5f6a7b8",
        ).yaml;

        expect(out).toContain("- jellyfin.abc.uncld.dev:8096/https");
        expect(out).toContain("- a1b2c3d4-e5f6a7b8-jellyfin_media:/media\n");
        expect(out).toContain("JELLYFIN_PublishedServerUrl: https://jellyfin.abc.uncld.dev");
    });

    it("summarizes services and generated secrets", () => {
        expect(
            summarizeVersion({
                compose:
                    "services:\n  app:\n    image: app:1\n    volumes:\n      - data:/data\n      - /anon\n      - { source: logs, target: /logs }\n  worker:\n",
                env: "USER=app\nPASSWORD={{ 32 }}\n# X={{ 8 }}\nKEY = {{uuid}}\n",
            }),
        ).toEqual({
            services: [
                {
                    name: "app",
                    image: "app:1",
                    volumes: [
                        { source: "data", target: "/data" },
                        { source: null, target: "/anon" },
                        { source: "logs", target: "/logs" },
                    ],
                },
                { name: "worker", image: null, volumes: [] },
            ],
            secrets: ["PASSWORD", "KEY"],
            required: [],
        });
    });

    it("finds and fills required variables", () => {
        const env = "HOST=\n  EMAIL = \nUSER=app\n# NOTE=\nKEY={{ 8 }}\n";

        expect(requiredVariables(env)).toEqual(["HOST", "EMAIL"]);
        expect(
            parseEnv(fillVariables(env, { HOST: "a # b", EMAIL: 'it\'s "x" $Y' })),
        ).toMatchObject({ HOST: "a # b", EMAIL: 'it\'s "x" $$Y', USER: "app" });
    });

    it("finds the published postgres TCP port", () => {
        const service = (ports: string) =>
            postgresService(`services:\n  db:\n    image: postgres\n${ports}`);

        expect(service("")).toEqual({ name: "db", published: undefined });
        expect(service("    ports: ['5432']\n")?.published).toBeUndefined();
        expect(service("    x-ports: ['db.example.com:5432/https']\n")?.published).toBeUndefined();
        expect(service("    ports: ['8080:80', '15432:5432']\n")?.published).toEqual({
            target: 5432,
            port: 15432,
            host: undefined,
        });
        expect(service("    x-ports: ['1.2.3.4:6543:5432/tcp@host']\n")?.published).toEqual({
            target: 5432,
            port: 6543,
            host: "1.2.3.4",
        });
        expect(
            service("    ports: [{ target: 5432, published: 5433, protocol: tcp }]\n")?.published,
        ).toEqual({ target: 5432, port: 5433, host: undefined });
        expect(
            service("    ports: [{ target: 5432, published: 5433, protocol: udp }]\n")?.published,
        ).toBeUndefined();
    });

    it("expands each placeholder independently", () => {
        const [a, b, uuid] = expandSecrets("{{ 32 }} {{32}} {{ uuid }}").split(" ");

        expect(a).toMatch(/^[A-Za-z0-9+/]{32}$/u);
        expect(b).toMatch(/^[A-Za-z0-9+/]{32}$/u);
        expect(a).not.toBe(b);
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
        expect(() => expandSecrets("{{ 0 }}")).toThrow();
        expect(() => expandSecrets("{{ 257 }}")).toThrow();
    });

    describe.each(
        templates.flatMap(({ appId, versions }) =>
            Object.entries(versions).map(([version, files]) => ({ appId, version, files })),
        ),
    )("$appId@$version", ({ appId, files }) => {
        const prefix = "a1b2c3d4-e5f6a7b8";
        const domain = "abc.uncld.dev";

        // Same steps as creating the resource and then deploying it.
        const env = fillVariables(
            expandSecrets(files.env, domain),
            Object.fromEntries(requiredVariables(files.env).map((key) => [key, "required-value"])),
        );

        const compose = expandSecrets(files.compose, domain);

        const rendered = v.parse(
            renderedSchema,
            YAML.parse(
                formatComposeFile(interpolateCompose(compose, env, prefix, domain), prefix).yaml,
            ),
        );

        const services = Object.entries(rendered.services);

        it("only references variables it defines or Stoat provides", () => {
            const builtIns = summarizeVersion(files).services.flatMap(({ name }) => {
                const variable = name.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");

                return [`${variable}_SERVICE_NAME`, `${variable}_INTERNAL_HOST`];
            });

            const defined = new Set([
                ...Object.keys(parseEnv(env)),
                ...builtIns,
                "STOAT_PREFIX",
                "STOAT_DOMAIN",
            ]);

            // `$$` is an escaped literal `$`, not a reference.
            const referenced = Array.from(
                (compose + env).replaceAll("$$", "").matchAll(/\$\{?([A-Za-z_]\w*)/gu),
                ([, name = ""]) => name,
            );

            expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
        });

        it("follows the template rules", () => {
            expect(compose + env).not.toMatch(/\{\{\s*(?:UUID|DNS|\d+)\s*\}\}/iu);

            for (const [, service] of services) {
                expect(service).not.toHaveProperty("env_file");
                expect(service).not.toHaveProperty("container_name");
            }
        });

        it("gives every service a healthcheck", () => {
            const missing = services.flatMap(([name, service]) =>
                service.healthcheck ? [] : [name],
            );

            expect(missing).toEqual(
                // FROM scratch image: nothing inside it can run a probe.
                appId === "basedbin" ? [`${prefix}-basedbin`] : [],
            );
        });

        it("only waits on services that report health", () => {
            for (const [, service] of services) {
                for (const [target, { condition }] of Object.entries(service.depends_on ?? {})) {
                    if (condition === "service_healthy")
                        expect(rendered.services[target]?.healthcheck).toBeDefined();
                }
            }
        });
    });

    it("expands {{ DNS }} to the cluster domain", () => {
        expect(expandSecrets("HOST=files.{{ DNS }}\nURL=https://{{dns}}", "abc.uncld.dev")).toBe(
            "HOST=files.abc.uncld.dev\nURL=https://abc.uncld.dev",
        );
        expect(() => expandSecrets("HOST={{ DNS }}")).toThrow();
    });
});
