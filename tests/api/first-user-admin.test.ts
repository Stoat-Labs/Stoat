import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@stoat/db";
import { setSignupsEnabled } from "@stoat/db/settings";
import { createAuth } from "../../packages/auth/src";

describe("first account (PostgreSQL)", () => {
    const databaseName = `stoat_first_user_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let auth: ReturnType<typeof createAuth>;

    async function signUp(email: string) {
        const { user } = await auth.api.signUpEmail({
            body: { name: "Test", email, password: "test-password-long-enough" },
        });

        return user.id;
    }

    async function roleOf(id: string) {
        const result = await db.$client.query('SELECT role FROM "user" WHERE id = $1', [id]);

        return result.rows[0]?.role;
    }

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        auth = createAuth({ APP_URL: "http://localhost:5173", APP_SECRET: "x".repeat(32) }, db);
    });

    afterAll(async () => {
        await db?.$client.end();
        await admin?.$client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await admin?.$client.end();
    });

    it("makes only the first sign-up the instance admin", async () => {
        const first = await signUp("first@example.test");
        await setSignupsEnabled(db, true);
        const second = await signUp("second@example.test");

        expect(await roleOf(first)).toBe("admin");
        expect(await roleOf(second)).not.toBe("admin");
    });
});
