import { parseEnv } from "node:util";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import {
    ComposeMoveError,
    moveComposeService,
    unpinVolumeNames,
} from "../../packages/api/src/compose-move";

const source = `# app stack
services:
  web:
    image: nginx
    depends_on: [db]
    environment:
      API_KEY: \${API_KEY}
  db:
    image: postgres:18
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d
    environment:
      POSTGRES_PASSWORD: \${DB_PASSWORD}
volumes:
  pg-data:
`;

const target = `services:
  worker:
    image: alpine
`;

function move(
    service: string,
    overrides: { target?: string; targetEnv?: string; sourceEnv?: string } = {},
) {
    return moveComposeService({
        service,
        source,
        target: overrides.target ?? target,
        sourcePrefix: "aaaaaaaa-bbbbbbbb",
        sourceEnv: overrides.sourceEnv ?? "API_KEY=key\nDB_PASSWORD='p@ss'\n",
        targetEnv: overrides.targetEnv ?? "OTHER=1\n",
    });
}

describe("moveComposeService", () => {
    it("moves the service and pins its volume to the old prefixed name so data follows", () => {
        const result = move("db");
        const moved = YAML.parse(result.target);
        const left = YAML.parse(result.source);

        expect(Object.keys(moved.services)).toEqual(["worker", "db"]);
        expect(moved.volumes).toEqual({ "pg-data": { name: "aaaaaaaa-bbbbbbbb-pg-data" } });
        expect(Object.keys(left.services)).toEqual(["web"]);
        expect(left.volumes).toBeUndefined();
        // Comments outside the moved service survive.
        expect(result.source).toContain("# app stack");
    });

    it("drops depends_on links that would point at a missing service, with warnings", () => {
        const result = move("db");
        const left = YAML.parse(result.source);

        expect(left.services.web.depends_on).toBeUndefined();
        expect(result.warnings).toContain('A service left behind no longer waits for "db".');

        const back = move("web");

        expect(YAML.parse(back.target).services.web.depends_on).toBeUndefined();
        expect(back.warnings).toContain('"web" no longer waits for "db", which stays behind.');
    });

    it("copies the variables the service interpolates, keeping the target's own values", () => {
        expect(move("db").targetEnv).toBe("OTHER=1\nDB_PASSWORD='p@ss'\n");
        expect(move("db", { targetEnv: "DB_PASSWORD=mine\n" }).targetEnv).toBe(
            "DB_PASSWORD=mine\n",
        );
    });

    it("copies multiline values whole", () => {
        const sourceEnv = "DB_PASSWORD='first\nsecond'\nAPI_KEY=key\n";

        expect(parseEnv(move("db", { sourceEnv }).targetEnv).DB_PASSWORD).toBe("first\nsecond");
    });

    it("copies the variables a copied value interpolates", () => {
        const sourceEnv = "BASE=secret\nDB_PASSWORD=${BASE}\nAPI_KEY=key\n";

        expect(move("db", { sourceEnv }).targetEnv).toBe(
            "OTHER=1\nBASE=secret\nDB_PASSWORD=${BASE}\n",
        );
    });

    it("refuses name clashes instead of overwriting the target", () => {
        expect(() => move("db", { target: "services:\n  db:\n    image: mysql\n" })).toThrow(
            ComposeMoveError,
        );
        expect(() =>
            move("db", { target: "services:\n  x:\n    image: a\nvolumes:\n  pg-data:\n" }),
        ).toThrow('The target already defines volume "pg-data".');
    });

    it("reports when the source has no services left", () => {
        const single = moveComposeService({
            service: "only",
            source: "services:\n  only:\n    image: nginx\n",
            target,
            sourcePrefix: undefined,
            sourceEnv: "",
            targetEnv: "",
        });

        expect(single.sourceEmpty).toBe(true);
        expect(move("db").sourceEmpty).toBe(false);
    });

    it("splits a service into a new, empty resource with its volume, pinned, and its variables", () => {
        const result = move("db", { target: "", targetEnv: "" });

        expect(YAML.parse(result.target)).toEqual({
            services: {
                db: {
                    image: "postgres:18",
                    volumes: [
                        "pg-data:/var/lib/postgresql/data",
                        "./init:/docker-entrypoint-initdb.d",
                    ],
                    environment: { POSTGRES_PASSWORD: "${DB_PASSWORD}" },
                },
            },
            volumes: { "pg-data": { name: "aaaaaaaa-bbbbbbbb-pg-data" } },
        });
        // Block style, like a hand-written Compose file.
        expect(result.target).toMatch(/^services:\n {2}db:\n/u);
        expect(result.targetEnv).toBe("DB_PASSWORD='p@ss'\n");
        expect(YAML.parse(result.source).services).not.toHaveProperty("db");
    });
});

describe("unpinVolumeNames", () => {
    it("drops pinned volume names, keeping external ones", () => {
        const compose = `services:
  db:
    image: postgres
volumes:
  pg-data:
    name: aaaaaaaa-bbbbbbbb-pg-data
  shared:
    external: true
    name: shared-data
`;

        expect(YAML.parse(unpinVolumeNames(compose)).volumes).toEqual({
            "pg-data": {},
            shared: { external: true, name: "shared-data" },
        });
    });

    it("leaves files without pinned names untouched", () => {
        const compose = "services:\n  db:   {image: postgres}\nvolumes:\n  pg-data:\n";

        expect(unpinVolumeNames(compose)).toBe(compose);
    });
});
