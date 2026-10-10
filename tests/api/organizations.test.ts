import * as v from "valibot";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@stoat/db";
import { createAuth } from "../../packages/auth/src";
import { call } from "@orpc/server";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { listUserOrganizations } from "@stoat/db/organizations";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";

describe("organization authentication (PostgreSQL)", () => {
    const databaseName = `stoat_auth_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let auth: ReturnType<typeof createAuth>;
    const baseURL = "http://localhost:5173";
    const password = "test-password-long-enough";
    let first: { userId: string; organizationId: string; cookie: string };
    let second: typeof first;

    async function request(path: string, body?: Record<string, string>, cookie?: string) {
        const headers = new Headers({ origin: baseURL });

        if (body) headers.set("content-type", "application/json");

        if (cookie) headers.set("cookie", cookie);

        return auth.handler(
            new Request(`${baseURL}/api/auth${path}`, {
                method: body ? "POST" : "GET",
                headers,
                body: body ? JSON.stringify(body) : undefined,
            }),
        );
    }

    async function signup(email: string) {
        const response = await request("/sign-up/email", {
            name: "Same Name",
            email,
            password,
        });

        expect(response.status).toBe(200);

        const body = v.parse(
            v.object({ user: v.object({ id: v.string() }) }),
            await response.json(),
        );

        // Sign-up no longer provisions an organization; the app sends the user to /setup.
        expect(await listUserOrganizations(db, body.user.id)).toHaveLength(0);

        const created = await request(
            "/organization/create",
            { name: "Same Name's workspace", slug: `org-${randomUUID()}` },
            response.headers
                .getSetCookie()
                .map((value) => value.split(";")[0])
                .join("; "),
        );

        expect(created.status).toBe(200);

        // Creating reissues the session cookie with the new active organization.
        const cookie = created.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");

        const organizations = await listUserOrganizations(db, body.user.id);
        expect(organizations).toHaveLength(1);
        expect(organizations[0]!.role).toBe("owner");
        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(session?.session.activeOrganizationId).toBe(organizations[0]!.id);

        return { userId: body.user.id, organizationId: organizations[0]!.id, cookie };
    }

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        auth = createAuth(
            {
                APP_URL: baseURL,
                APP_SECRET: "integration-test-secret-at-least-32-characters",
            },
            db,
        );
        // Sign-ups start closed; these tests register users freely.
        expect(await getSignupsEnabled(db)).toBe(false);
        await setSignupsEnabled(db, true);
    }, 30000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("blocks signup immediately when disabled, preserves login, and can reopen signup", async () => {
        expect(await getSignupsEnabled(db)).toBe(true);
        await signup("signup-setting-existing@example.com");
        await setSignupsEnabled(db, false);

        try {
            expect(await getSignupsEnabled(db)).toBe(false);

            const blocked = await request("/sign-up/email", {
                name: "Blocked",
                email: "signup-setting-blocked@example.com",
                password,
            });

            expect(blocked.status).toBe(403);
            expect(await blocked.json()).toMatchObject({ message: "User signups are disabled." });
            expect(
                (
                    await db.$client.query('SELECT id FROM "user" WHERE email = $1', [
                        "signup-setting-blocked@example.com",
                    ])
                ).rows,
            ).toHaveLength(0);

            const login = await request("/sign-in/email", {
                email: "signup-setting-existing@example.com",
                password,
            });

            expect(login.status).toBe(200);
        } finally {
            await setSignupsEnabled(db, true);
        }

        await signup("signup-setting-blocked@example.com");
        await db.$client.query(
            `DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE 'signup-setting-%'))`,
        );
        await db.$client.query(`DELETE FROM "user" WHERE email LIKE 'signup-setting-%'`);
    });

    it("creates distinct owned organizations and active sessions for same-name users", async () => {
        first = await signup("first@example.test");
        second = await signup("second@example.test");
        expect(first.organizationId).not.toBe(second.organizationId);
    });

    it("rejects duplicate signup without creating another organization", async () => {
        await request("/sign-up/email", {
            name: "Same Name",
            email: "first@example.test",
            password,
        });
        expect(await listUserOrganizations(db, first.userId)).toHaveLength(1);
    });

    it("logs in with an active organization and rejects incorrect credentials", async () => {
        const bad = await request("/sign-in/email", {
            email: "first@example.test",
            password: "incorrect-password",
        });

        expect(bad.status).toBe(401);
        const good = await request("/sign-in/email", { email: "first@example.test", password });
        expect(good.status).toBe(200);
        expect(await listUserOrganizations(db, first.userId)).toHaveLength(1);

        const cookie = good.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");

        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(session?.session.activeOrganizationId).toBe(first.organizationId);
    });

    it("denies switching to another user's organization", async () => {
        const response = await request(
            "/organization/set-active",
            { organizationId: second.organizationId },
            first.cookie,
        );

        expect(response.ok).toBe(false);

        const restored = await request(
            "/organization/set-active",
            { organizationId: first.organizationId },
            first.cookie,
        );

        expect(restored.ok).toBe(true);
    });

    it("scopes cluster access and rejects forged organization and unauthenticated access", async () => {
        for (const user of [first, second]) {
            await db.$client.query(
                `INSERT INTO clusters (id, name, organization_id, created_at, updated_at, sidecar_url, sidecar_token) VALUES ($1, $2, $3, now(), now(), 'http://sidecar.invalid', 'secret')`,
                [randomUUID(), user.userId, user.organizationId],
            );
        }

        const session = await auth.api.getSession({
            headers: new Headers({ cookie: first.cookie }),
        });

        const result = await call(clusterRouter.listClusters, undefined, {
            context: { db, session },
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.organizationId).toBe(first.organizationId);
        expect(result.items[0]).not.toHaveProperty("sidecarToken");
        expect(result.total).toBe(1);
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: { db, session: null },
            }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: {
                    db,
                    session: {
                        ...session!,
                        session: {
                            ...session!.session,
                            activeOrganizationId: second.organizationId,
                        },
                    },
                },
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("creates additional organizations, switches to them, and invalidates logout sessions", async () => {
        const response = await request(
            "/organization/create",
            { name: "Another workspace", slug: "another-workspace" },
            first.cookie,
        );

        expect(response.status).toBe(200);
        const organization = v.parse(v.object({ id: v.string() }), await response.json());

        // The browser keeps the cookies reissued by create, including the session cache.
        const cookie = response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; ");

        const session = await auth.api.getSession({ headers: new Headers({ cookie }) });

        expect(session?.session.activeOrganizationId).toBe(organization.id);

        const switched = await request(
            "/organization/set-active",
            { organizationId: first.organizationId },
            cookie,
        );

        expect(switched.ok).toBe(true);
        const logout = await request("/sign-out", {}, cookie);
        expect(logout.ok).toBe(true);
        // Sign-out expires the cached session cookie in the browser. A replayed copy stays valid
        // until the cookie cache maxAge, so the live session is what must be gone.
        expect(logout.headers.getSetCookie()).toContainEqual(
            expect.stringMatching(/session_data=;.*Max-Age=0/u),
        );
        expect(
            await auth.api.getSession({
                headers: new Headers({ cookie }),
                query: { disableCookieCache: true },
            }),
        ).toBeNull();
    });

    it("rejects a real authenticated session after its organization membership is revoked", async () => {
        const user = await signup("revoked@example.test");
        const headers = new Headers({ cookie: user.cookie });
        const session = await auth.api.getSession({ headers });

        expect(session?.session.activeOrganizationId).toBe(user.organizationId);
        await expect(
            call(clusterRouter.listClusters, undefined, { context: { db, session } }),
        ).resolves.toMatchObject({ items: [], total: 0 });

        const deleted = await db.$client.query(
            "DELETE FROM member WHERE user_id = $1 AND organization_id = $2",
            [user.userId, user.organizationId],
        );

        expect(deleted.rowCount).toBe(1);
        const staleSession = await auth.api.getSession({ headers });

        expect(staleSession?.user.id).toBe(user.userId);
        expect(staleSession?.session.activeOrganizationId).toBe(user.organizationId);
        await expect(
            call(clusterRouter.listClusters, undefined, {
                context: { db, session: staleSession },
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
