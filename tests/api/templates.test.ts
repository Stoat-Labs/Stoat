import { parseEnv } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { postgresService } from "../../packages/api/src/compose";
import {
    expandSecrets,
    fillVariables,
    requiredVariables,
    summarizeVersion,
    templates,
} from "../../packages/api/src/templates";
import { formatComposeFile, interpolateCompose } from "../../packages/workflows/src/compose";

describe("templates", () => {
    it("loads the postgresql template", () => {
        const postgres = templates.find((template) => template.appId === "postgresql");

        expect(postgres).toMatchObject({
            name: "PostgreSQL",
            type: "postgresql",
            tags: ["database"],
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

    it("expands {{ DNS }} to the cluster domain", () => {
        expect(expandSecrets("HOST=files.{{ DNS }}\nURL=https://{{dns}}", "abc.uncld.dev")).toBe(
            "HOST=files.abc.uncld.dev\nURL=https://abc.uncld.dev",
        );
        expect(() => expandSecrets("HOST={{ DNS }}")).toThrow();
    });
});
