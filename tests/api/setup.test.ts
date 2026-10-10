import * as v from "valibot";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@stoat/db";
import { listUserOrganizations } from "@stoat/db/organizations";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";
import { isSetupRequired } from "@stoat/db/setup";
import { createAuth } from "../../packages/auth/src";
import { dropTestDatabase } from "../database";

const migrationsFolder = resolve("packages/db/src/migrations");

async function createTestDatabase(admin: ReturnType<typeof createDb>, name: string) {
    await admin.$client.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const db = createDb({ DATABASE_URL: url.toString() });
    await migrate(db, { migrationsFolder });

    return db;
}

describe("first-run setup (PostgreSQL)", () => {
    const databaseName = `stoat_setup_test_${randomUUID().replaceAll("-", "")}`;
    const baseURL = "http://localhost:5173";
    const password = "test-password-long-enough";
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let auth: ReturnType<typeof createAuth>;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        db = await createTestDatabase(admin, databaseName);
        auth = createAuth(
            { APP_URL: baseURL, APP_SECRET: "test-secret-that-is-long-enough-123" },
            db,
        );
    });

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
        }

        await admin?.$client.end();
    });

    function signUp(email: string) {
        return auth.handler(
            new Request(`${baseURL}/api/auth/sign-up/email`, {
                method: "POST",
                headers: { origin: baseURL, "content-type": "application/json" },
                body: JSON.stringify({ name: "Person", email, password }),
            }),
        );
    }

    async function roleOf(email: string) {
        const { rows } = await db.$client.query<{ role: string | null }>(
            'SELECT role FROM "user" WHERE email = $1',
            [email.toLowerCase()],
        );

        return rows[0]?.role;
    }

    it("lets the first account in while sign-ups are closed and makes it the admin", async () => {
        expect(await isSetupRequired(db)).toBe(true);
        expect(await getSignupsEnabled(db)).toBe(false);

        const response = await signUp("admin@example.test");

        expect(response.status).toBe(200);

        const { user } = v.parse(
            v.object({ user: v.object({ id: v.string() }) }),
            await response.json(),
        );

        expect(await roleOf("admin@example.test")).toBe("admin");
        // Organizations are created explicitly in /setup now.
        expect(await listUserOrganizations(db, user.id)).toHaveLength(0);
        expect(await isSetupRequired(db)).toBe(false);
    });

    it("rejects later sign-ups while they are closed", async () => {
        const response = await signUp("stranger@example.test");

        expect(response.status).toBe(403);
        expect(await roleOf("stranger@example.test")).toBeUndefined();
    });

    it("admits an invited email while sign-ups are closed", async () => {
        const login = await auth.handler(
            new Request(`${baseURL}/api/auth/sign-in/email`, {
                method: "POST",
                headers: { origin: baseURL, "content-type": "application/json" },
                body: JSON.stringify({ email: "admin@example.test", password }),
            }),
        );

        const headers = new Headers({
            cookie: login.headers
                .getSetCookie()
                .map((cookie) => cookie.split(";")[0])
                .join("; "),
        });

        const organization = await auth.api.createOrganization({
            body: { name: "Acme", slug: "acme" },
            headers,
        });

        await auth.api.createInvitation({
            body: {
                email: "invitee@example.test",
                role: "member",
                organizationId: organization!.id,
            },
            headers,
        });

        // Invitation emails are matched case-insensitively.
        expect((await signUp("Invitee@Example.test")).status).toBe(200);
        expect(await roleOf("invitee@example.test")).not.toBe("admin");
        expect((await signUp("other@example.test")).status).toBe(403);
    });

    it("never promotes a later account, even with no admin left", async () => {
        await db.$client.query(`UPDATE "user" SET role = 'user' WHERE role = 'admin'`);
        await setSignupsEnabled(db, true);

        expect((await signUp("later@example.test")).status).toBe(200);
        expect(await roleOf("later@example.test")).not.toBe("admin");
    });
});
