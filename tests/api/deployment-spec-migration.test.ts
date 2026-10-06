import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, inject, it } from "vite-plus/test";

it("applies deployment spec migration before or after a development schema push", async () => {
    const url = new URL(inject("databaseUrl"));
    const databaseName = `deployment_spec_${randomUUID().replaceAll("-", "")}`;
    const admin = createDb({ DATABASE_URL: url.toString() });
    url.pathname = `/${databaseName}`;
    const db = createDb({ DATABASE_URL: url.toString() });
    let created = false;

    try {
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        created = true;

        const migration = readMigrationFiles({
            migrationsFolder: resolve("packages/db/src/migrations"),
        })[26]!;

        for (const alreadyPushed of [false, true]) {
            await db.$client.query("CREATE TABLE deployments (id text PRIMARY KEY)");
            await db.$client.query("CREATE TABLE resource_deployment_inputs (spec text)");

            if (alreadyPushed) {
                await db.$client.query("ALTER TABLE deployments ADD COLUMN spec text");
                await db.$client.query("ALTER TABLE resource_deployment_inputs DROP COLUMN spec");
                await db.$client.query(
                    "INSERT INTO deployments VALUES ('existing', 'services: {}')",
                );
            }

            for (const statement of migration.sql) await db.$client.query(statement);

            const columns = await db.$client.query<{ table_name: string }>(
                `SELECT table_name FROM information_schema.columns
                 WHERE table_schema = 'public' AND column_name = 'spec' ORDER BY table_name`,
            );

            expect(columns.rows).toEqual([{ table_name: "deployments" }]);

            if (alreadyPushed) {
                const existing = await db.$client.query("SELECT spec FROM deployments");
                expect(existing.rows).toEqual([{ spec: "services: {}" }]);
            }

            await db.$client.query("DROP TABLE deployments, resource_deployment_inputs");
        }
    } finally {
        await db.$client.end();

        try {
            if (created) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
        } finally {
            await admin.$client.end();
        }
    }
});
