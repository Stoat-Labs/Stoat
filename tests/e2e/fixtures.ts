import { resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { createDb } from "@stoat/db";
import * as v from "valibot";

export const storageState = resolve(
    import.meta.dirname,
    "../../test-results/e2e/storage-state.json",
);

// Fixed ids so global setup (seeding) and specs (assertions) agree without shared state.
export const ids = {
    mainCluster: "c0000000-0000-4000-8000-000000000001",
    otherCluster: "c0000000-0000-4000-8000-000000000002",
    lonelyCluster: "c0000000-0000-4000-8000-000000000003",
    shop: "a0000000-0000-4000-8000-000000000001",
    jobs: "a0000000-0000-4000-8000-000000000002",
    elsewhere: "a0000000-0000-4000-8000-000000000003",
    internal: "a0000000-0000-4000-8000-000000000004",
    lonely: "a0000000-0000-4000-8000-000000000005",
    api: "b0000000-0000-4000-8000-000000000001",
    postgres: "b0000000-0000-4000-8000-000000000002",
    worker: "b0000000-0000-4000-8000-000000000004",
    elsewhereResource: "b0000000-0000-4000-8000-000000000005",
    monitoring: "b0000000-0000-4000-8000-000000000006",
    solo: "b0000000-0000-4000-8000-000000000007",
} as const;

export const memberStorageState = resolve(
    import.meta.dirname,
    "../../test-results/e2e/member-storage-state.json",
);

/** The certificate RustFS serves, written by global setup. */
export const rustfsCaFile = resolve(import.meta.dirname, "../../test-results/e2e/rustfs-ca.pem");

/** Root keys of the RustFS container behind the seeded `assets` bucket. */
export const rustfsRoot = { accessKey: "stoat-root", secretKey: "stoat-root-secret-key" };

/** Owner of the seeded organization, and instance admin. */
export const user = { email: "e2e@example.test", password: "e2e-password-123", name: "E2E" };

/** A plain member of the same organization. */
export const member = {
    email: "member@example.test",
    password: "member-password-123",
    name: "Member",
};

export const apiSpec =
    "services:\n  api:\n    image: nginx:alpine\n    environment:\n      URL: ${URL}\n";

export const postgresEnv = [
    "POSTGRES_USER=shop",
    "POSTGRES_PASSWORD='s3cr$$t'",
    "DATABASE_URL=postgres://${POSTGRES_USER}@${DB_INTERNAL_HOST}:5432/shop",
].join("\n");

export const variablesPath = (projectId: string, resourceId: string) =>
    `/projects/${projectId}/${resourceId}/variables`;

export const ref = (id: string, key: string) => `{{ ${id}.${key} }}`;

let db: ReturnType<typeof createDb> | undefined;

/** Runs one query against the e2e database. */
export async function sql<Row extends Record<string, string | null>>(
    text: string,
    values: string[] = [],
) {
    db ??= createDb({ DATABASE_URL: process.env.E2E_DATABASE_URL! });

    return (await db.$client.query<Row>(text, values)).rows;
}

/** Puts every seeded resource back the way global setup left it. */
export async function resetData() {
    await sql("DELETE FROM deployments");
    await sql(
        `UPDATE resources SET settings = '{"env":"PORT=3000"}', draft_spec = $2, spec = NULL WHERE id = $1`,
        [ids.api, apiSpec],
    );
    await sql(`UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`, [
        ids.postgres,
        postgresEnv,
    ]);
    await resetSidecar();
}

/** The organization every seeded row belongs to. */
export async function organizationId() {
    const [row] = await sql<{ organization_id: string }>(
        "SELECT organization_id FROM clusters WHERE id = $1",
        [ids.mainCluster],
    );

    return row!.organization_id;
}

/** The id of the seeded `assets` bucket resource, created through the API at setup. */
export async function assetsId() {
    const [row] = await sql<{ id: string }>(
        "SELECT id FROM resources WHERE project_id = $1 AND name = 'assets'",
        [ids.shop],
    );

    return row!.id;
}

/** A JSON value, as oRPC sends procedure input. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

export type JsonObject = { [key: string]: Json };

/** Forgets every deploy and service the fake sidecar has seen. */
export async function resetSidecar() {
    await fetch(`${process.env.E2E_SIDECAR_URL}/__reset`, { method: "POST" });
}

/**
 * Calls an oRPC procedure as the page's signed-in user, for setting up state a test is not
 * about. Fails the test on any error and returns the created row's id when there is one.
 */
export async function rpc(page: Page, path: string, input: JsonObject) {
    const response = await page.request.post(`/rpc/${path}`, {
        data: { json: input },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    if (!response.ok()) throw new Error(`${path} failed: ${await response.text()}`);

    const body = v.parse(
        v.object({ json: v.optional(v.nullable(v.looseObject({ id: v.optional(v.string()) }))) }),
        await response.json(),
    );

    return { id: body.json?.id ?? "" };
}

/** Names of the services the fake sidecar is running. */
export async function runningServices() {
    const response = await fetch(`${process.env.E2E_SIDECAR_URL}/api/v1/services`);

    const body = v.parse(
        v.object({ items: v.array(v.object({ name: v.string() })) }),
        await response.json(),
    );

    return body.items.map((service) => service.name);
}

/** Compose files the fake sidecar received, decoded. */
export async function receivedComposes() {
    const response = await fetch(`${process.env.E2E_SIDECAR_URL}/__received`);

    return v.parse(v.array(v.string()), await response.json());
}

let accounts = 0;

let clients = 0;

/**
 * A client address nobody else in this run uses. Sign-up and sign-in are rate limited per
 * address, and every test reaches the server from 127.0.0.1, so tests that act as different
 * people say so through `x-forwarded-for` (the server runs as if behind a proxy).
 */
export function clientHeaders() {
    clients += 1;

    return {
        "x-forwarded-for": `10.${process.pid % 250}.${Math.floor(clients / 250)}.${clients % 250}`,
    };
}

/** Details for an account nobody has used yet, in this run or any other. */
export function newAccount() {
    accounts += 1;

    return {
        name: `Person ${accounts}`,
        email: `person-${Date.now()}-${accounts}@example.test`,
        password: "a-long-password",
    };
}

/**
 * A browser context signed in as a brand-new account that owns its own organization, for
 * tests that change account or organization state the shared owner relies on.
 */
export async function freshAccount(browser: Browser) {
    const account = newAccount();
    const baseURL = process.env.E2E_BASE_URL!;

    const context = await browser.newContext({
        baseURL,
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: clientHeaders(),
    });

    const response = await context.request.post("/api/auth/sign-up/email", {
        data: account,
        headers: { origin: baseURL },
    });

    if (!response.ok()) throw new Error(`Sign-up failed: ${await response.text()}`);

    const [row] = await sql<{ organization_id: string }>(
        `SELECT m.organization_id FROM member m JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
        [account.email],
    );

    return {
        account,
        context,
        page: await context.newPage(),
        organizationId: row!.organization_id,
    };
}

/** A signed-out browser context. */
export function anonymousContext(browser: Browser) {
    return browser.newContext({
        baseURL: process.env.E2E_BASE_URL,
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: clientHeaders(),
    });
}
