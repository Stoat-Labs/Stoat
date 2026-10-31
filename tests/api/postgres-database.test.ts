import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { interpolateCompose } from "@stoat/workflows/compose";
import { clusters, projects, resources } from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import {
    parsePsqlOutput,
    preloadStatements,
    replacePostgresPassword,
} from "../../packages/api/src/routers/resources/postgres";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

describe("replacePostgresPassword", () => {
    it("rewrites only the password line", () => {
        const next = replacePostgresPassword(
            "# admin\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=old\nPOSTGRES_DB=app",
            "new",
        );

        expect(next).toEqual({
            env: "# admin\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=new\nPOSTGRES_DB=app",
        });
    });

    it("refuses references, interpolation and a missing variable", () => {
        for (const env of [
            "POSTGRES_PASSWORD={{ 0b7c3c4e-0000-4000-8000-000000000000.SECRET }}",
            "POSTGRES_PASSWORD=${SECRET}",
            "POSTGRES_USER=postgres",
        ])
            expect(replacePostgresPassword(env, "new")).toHaveProperty("error");

        expect(replacePostgresPassword("POSTGRES_PASSWORD='a$b'", "new")).toHaveProperty("env");
    });
});

describe("preloadStatements", () => {
    const command = (compose: string) => YAML.parse(preloadStatements(compose)).services.db.command;

    it("adds a command, or extends one that is a list", () => {
        expect(command("services:\n  db:\n    image: postgres:18\n")).toEqual([
            "postgres",
            "-c",
            "shared_preload_libraries=pg_stat_statements",
        ]);
        expect(
            command(
                'services:\n  db:\n    image: postgres:18\n    command: ["postgres", "-c", "max_connections=200"]\n',
            ),
        ).toEqual([
            "postgres",
            "-c",
            "max_connections=200",
            "-c",
            "shared_preload_libraries=pg_stat_statements",
        ]);
    });

    it("leaves an enabled command alone and refuses one it can't extend", () => {
        const enabled =
            "services:\n  db:\n    command: postgres -c shared_preload_libraries=pg_stat_statements\n";

        expect(preloadStatements(enabled)).toBe(enabled);
        expect(() =>
            preloadStatements("services:\n  db:\n    command: postgres -c fsync=off\n"),
        ).toThrow("own command");
    });
});

describe("addConnectionPooler", () => {
    const databaseName = `stoat_pooler_api_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(
            db,
            "pooler",
            "Pooler",
            "pooler@example.test",
        );

        // SAFETY: these procedures only read the session identity and organization.
        context = {
            db,
            session: {
                user: { id: "pooler" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://127.0.0.1:1",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
        await db.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Postgres",
            type: "database",
            settings: {
                engine: "postgresql",
                env: "POSTGRES_USER=postgres\nPOSTGRES_PASSWORD=secret\nPOSTGRES_DB=app",
            },
            draftSpec: "services:\n  postgres:\n    image: postgres:18\n",
        });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    it("adds one PgDog resource wired to the database by references", async () => {
        const input = { clusterId, projectId, resourceId };
        const pooler = await call(resourcesRouter.addConnectionPooler, input, { context });

        expect(pooler.draftSpec).toContain("ghcr.io/pgdogdev/pgdog:");
        // SAFETY: the procedure always stores Variables as a string in `settings.env`.
        expect(parseEnv((pooler.settings as { env: string }).env)).toEqual({
            POSTGRES_HOST: `{{ ${resourceId}.POSTGRES_INTERNAL_HOST }}`,
            POSTGRES_USER: `{{ ${resourceId}.POSTGRES_USER }}`,
            POSTGRES_PASSWORD: `{{ ${resourceId}.POSTGRES_PASSWORD }}`,
            POSTGRES_DB: `{{ ${resourceId}.POSTGRES_DB }}`,
        });

        // PgDog reads only its TOML files, so the Variables must land in the config content.
        const deployed = YAML.parse(
            interpolateCompose(
                pooler.draftSpec!,
                "POSTGRES_HOST=db.internal\nPOSTGRES_USER=postgres\nPOSTGRES_PASSWORD=s3cret\nPOSTGRES_DB=app",
            ),
        );

        expect(deployed.configs["pgdog-users"].content).toContain('password = "s3cret"');
        expect(deployed.configs.pgdog.content).toContain('host = "db.internal"');

        await expect(call(resourcesRouter.addConnectionPooler, input, { context })).rejects.toThrow(
            "already pools",
        );
    });

    it("keeps the old password when the server can't take the new one", async () => {
        await db
            .update(resources)
            .set({ spec: "services:\n  postgres:\n    image: postgres:18\n" })
            .where(eq(resources.id, resourceId));

        // The sidecar at 127.0.0.1:1 is unreachable, so ALTER ROLE never runs.
        await expect(
            call(
                resourcesRouter.regeneratePostgresPassword,
                { clusterId, projectId, resourceId },
                { context },
            ),
        ).rejects.toThrow();

        const [row] = await db.select().from(resources).where(eq(resources.id, resourceId));

        // SAFETY: the fixture stores Variables as a string in `settings.env`.
        expect(parseEnv((row!.settings as { env: string }).env).POSTGRES_PASSWORD).toBe("secret");
    });
});

describe("parsePsqlOutput", () => {
    it("reads the last result, with NULLs, empty strings and newlines apart", () => {
        expect(
            parsePsqlOutput("a\x1fb\x1e1\x1f\x1d\x1e2\x1f\x1e3\x1fmulti\nline\x1e(3 rows)\n"),
        ).toEqual({
            columns: ["a", "b"],
            rows: [
                ["1", null],
                ["2", ""],
                ["3", "multi\nline"],
            ],
            command: "SELECT 3",
        });
        expect(parsePsqlOutput("one\x1e1\x1e(1 row)\nx\x1e(0 rows)\n")).toEqual({
            columns: ["x"],
            rows: [],
            command: "SELECT 0",
        });
    });

    it("reports statements that return no rows as done", () => {
        expect(parsePsqlOutput("")).toEqual({ columns: [], rows: [], command: "Done" });
    });
});
