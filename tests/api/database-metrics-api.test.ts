import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusters, projects, resources } from "@stoat/db/schema/index";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

describe("database metrics API", () => {
    const databaseName = `stoat_metrics_api_${randomUUID().replaceAll("-", "")}`;
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
            "metrics",
            "Metrics",
            "metrics@example.test",
        );

        // SAFETY: these procedures only read the session identity and organization.
        context = {
            db,
            session: {
                user: { id: "metrics" },
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
            settings: { engine: "postgresql", env: "POSTGRES_PASSWORD=secret" },
            draftSpec: "services:\n  db:\n    image: postgres:18\n",
        });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    it("adds one exporter when two requests race", async () => {
        const input = { projectId, resourceId };
        const holder = await db.$client.connect();
        let settled = 0;

        // Holding the database row makes both requests reach their duplicate check together.
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM resources WHERE id = $1 FOR UPDATE", [resourceId]);

        const requests = [1, 2].map(() =>
            call(resourcesRouter.addDatabaseMetrics, input, { context }).finally(() => settled++),
        );

        for (let attempt = 0; attempt < 100 && settled < 2; attempt++) {
            const { rows } = await admin.$client.query<{ waiting: number }>(
                "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
                [databaseName],
            );

            if (rows[0]?.waiting === 2) break;
            await new Promise((done) => setTimeout(done, 20));
        }

        await holder.query("COMMIT");
        holder.release();

        const results = await Promise.allSettled(requests);

        expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(await db.select().from(resources)).toHaveLength(2);
    });
});
