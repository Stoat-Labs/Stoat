import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// DATABASE_URL is only used to create/drop a uniquely named disposable database.
describe("Monitoring machine name migration 0025 (PostgreSQL)", () => {
    const databaseName = `stoat_machine_migration_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let databaseCreated = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL)
            throw new Error("Testcontainers setup must provide DATABASE_URL");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        databaseCreated = true;
        const url = new URL(process.env.DATABASE_URL);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            try {
                if (databaseCreated) await admin.$client.query(`DROP DATABASE "${databaseName}"`);
            } finally {
                await admin.$client.end();
            }
        }
    });

    it("renames the configuration key, keeping legacy IDs and other settings", async () => {
        const migrations = readMigrationFiles({
            migrationsFolder: resolve("packages/db/src/migrations"),
        });

        const machineMigration = migrations[25]!;
        expect(machineMigration.sql.join("\n")).toContain('DROP COLUMN "machine_id"');

        await db.transaction(async (tx) => {
            for (const migration of migrations.slice(0, 25)) {
                for (const statement of migration.sql) await tx.execute(sql.raw(statement));
            }
        });

        const organizationId = randomUUID();
        const legacy = randomUUID();
        const unconfigured = randomUUID();
        const storage = { type: "volume", source: "greptime" };

        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Migration', $1, now())`,
            [organizationId],
        );
        await db.$client.query(
            `INSERT INTO clusters (id, name, organization_id, sidecar_url, sidecar_token, initialization_configuration, created_at, updated_at)
             VALUES ($1, 'Legacy', $3, 'http://sidecar.test', 'unused', $4, now(), now()),
                    ($2, 'Unconfigured', $3, 'http://sidecar.test', 'unused', NULL, now(), now())`,
            [
                legacy,
                unconfigured,
                organizationId,
                JSON.stringify({ machineId: "machine-id-1", greptimeStorage: storage, retentionDays: 7 }),
            ],
        );

        await db.transaction(async (tx) => {
            for (const statement of machineMigration.sql) await tx.execute(sql.raw(statement));
        });

        const rows = await db.$client.query<{ id: string; configuration: unknown }>(
            `SELECT id, initialization_configuration AS configuration FROM clusters ORDER BY name`,
        );

        expect(rows.rows).toEqual([
            {
                id: legacy,
                configuration: { machine: "machine-id-1", greptimeStorage: storage, retentionDays: 7 },
            },
            { id: unconfigured, configuration: null },
        ]);
    });
});
