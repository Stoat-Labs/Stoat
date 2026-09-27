import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { listUserOrganizations } from "@stoat/db/organizations";
import { createAuth } from "../../packages/auth/src";
import { appRouter } from "../../packages/api/src/routers";

describe("organization API keys (PostgreSQL)", () => {
    const databaseName = `stoat_apikey_test_${randomUUID().replaceAll("-", "")}`;
    const baseURL = "http://localhost:5173";
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let auth: ReturnType<typeof createAuth>;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        auth = createAuth(
            { APP_URL: baseURL, APP_SECRET: "test-secret-that-is-long-enough-123" },
            db,
        );
    });

    afterAll(async () => {
        await db?.$client.end();
        await admin?.$client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin?.$client.end();
    });

    // Mirrors apps/web/src/context.ts.
    async function keyContext(key: string) {
        const { valid, key: apiKey } = await auth.api.verifyApiKey({ body: { key } });

        return {
            db,
            session: null,
            apiKey: valid && apiKey ? { id: apiKey.id, organizationId: apiKey.referenceId } : null,
        };
    }

    it("scopes a key to its organization and revokes it on delete", async () => {
        const response = await auth.handler(
            new Request(`${baseURL}/api/auth/sign-up/email`, {
                method: "POST",
                headers: { origin: baseURL, "content-type": "application/json" },
                body: JSON.stringify({
                    name: "Owner",
                    email: "owner@example.test",
                    password: "test-password-long-enough",
                }),
            }),
        );

        expect(response.status).toBe(200);
        const { user } = await response.json();

        const headers = new Headers({
            cookie: response.headers
                .getSetCookie()
                .map((c) => c.split(";")[0])
                .join("; "),
        });

        const [organization] = await listUserOrganizations(db, user.id);

        const created = await auth.api.createApiKey({
            body: { name: "ci", organizationId: organization!.id },
            headers,
        });

        expect(created.key.startsWith("stoat_")).toBe(true);
        expect(created.referenceId).toBe(organization!.id);

        const context = await keyContext(created.key);
        expect(context.apiKey?.organizationId).toBe(organization!.id);
        await expect(
            call(appRouter.cluster.listClusters, undefined, { context }),
        ).resolves.toBeDefined();
        // User-bound procedures reject keys.
        await expect(call(appRouter.privateData, undefined, { context })).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });

        const wrong = await keyContext(
            "stoat_not-a-real-key-at-all-000000000000000000000000000000",
        );

        await expect(
            call(appRouter.cluster.listClusters, undefined, { context: wrong }),
        ).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });

        await auth.api.deleteApiKey({ body: { keyId: created.id }, headers });
        expect((await keyContext(created.key)).apiKey).toBeNull();
    });
});
