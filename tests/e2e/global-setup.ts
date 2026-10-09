import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer, isIP } from "node:net";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { request } from "@playwright/test";
import * as v from "valibot";
import { createDb } from "@stoat/db";
import { clusters, projects, resources } from "@stoat/db/schema/index";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { generate } from "selfsigned";
import { GenericContainer, Wait } from "testcontainers";
import { startFakeSidecar } from "./fake-sidecar";
import { startGitServer } from "./git-server";
import {
    apiSpec,
    ids,
    member,
    memberStorageState,
    postgresEnv,
    rustfsCaFile,
    rustfsRoot,
    storageState,
    type JsonObject,
    user,
} from "./fixtures";

const root = resolve(import.meta.dirname, "../..");

/** The server trusts x-forwarded-for like it would behind a proxy, so every request sends it. */
const proxied = { "x-forwarded-for": "10.255.0.1" };

async function freePort() {
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    // SAFETY: listen(0, "127.0.0.1") creates a TCP server, never a Unix socket.
    const { port } = probe.address() as AddressInfo;
    probe.close();

    return port;
}

async function waitFor(url: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const ok = await fetch(url, { headers: proxied }).then(
            (response) => response.ok,
            () => false,
        );

        if (ok) return;
        await new Promise((done) => setTimeout(done, 500));
    }

    throw new Error(`Timed out waiting for ${url}`);
}

const APP_SECRET = "e2e-secret-that-is-at-least-32-characters-long";

/**
 * RustFS over TLS with a throwaway certificate, written to `rustfsCaFile` for the web server and
 * specs to trust. Reached through the Docker bridge gateway, a private address like a LAN
 * server, since Stoat refuses loopback endpoints.
 */
async function startRustfs() {
    const gateway = spawnSync(
        "docker",
        ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
        { encoding: "utf8" },
    ).stdout.trim();

    if (isIP(gateway) !== 4) throw new Error("Unable to find the Docker bridge gateway");

    const pems = await generate([{ name: "commonName", value: gateway }], {
        keySize: 2048,
        extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: gateway }] }],
    });

    const container = await new GenericContainer("rustfs/rustfs:1.0.1")
        .withEnvironment({
            RUSTFS_ACCESS_KEY: rustfsRoot.accessKey,
            RUSTFS_SECRET_KEY: rustfsRoot.secretKey,
            RUSTFS_TLS_PATH: "/certs",
        })
        .withCopyContentToContainer([
            { content: pems.cert, target: "/certs/rustfs_cert.pem", mode: 0o644 },
            { content: pems.private, target: "/certs/rustfs_key.pem", mode: 0o644 },
        ])
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp("/health", 9000).usingTls().allowInsecure())
        .start();

    writeFileSync(rustfsCaFile, pems.cert);


    return {
        container,
        endpoint: `https://${gateway}:${container.getMappedPort(9000)}`,
    };
}

/** The production bundle, built once; `E2E_SKIP_BUILD=1` reuses the last one. */
function buildWeb() {
    if (process.env.E2E_SKIP_BUILD === "1") return;

    // Build-time placeholders, like the Dockerfile; real values arrive at runtime.
    const { status } = spawnSync("pnpm", ["exec", "vp", "build"], {
        cwd: resolve(root, "apps/web"),
        stdio: "inherit",
        env: {
            ...process.env,
            NODE_ENV: "production",
            APP_SECRET,
            APP_URL: "http://localhost:3001",
            DATABASE_URL: "postgresql://build:build@localhost:5432/build",
        },
    });

    if (status !== 0) throw new Error("Building apps/web failed");
}

/**
 * Real stack for the variable reference e2e specs: Postgres container, migrations,
 * a fake sidecar, the production web server (with its deploy worker), seed data, and a
 * signed-in session. Production, not `vp dev`: unrelated file changes cannot reload pages
 * mid-test. Returns the teardown.
 */
export default async function globalSetup() {
    buildWeb();
    const postgres = await new PostgreSqlContainer("postgres:18-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    const db = createDb({ DATABASE_URL: databaseUrl });
    await migrate(db, { migrationsFolder: resolve(root, "packages/db/src/migrations") });

    const sidecar = await startFakeSidecar();
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    mkdirSync(resolve(root, "test-results/e2e"), { recursive: true });
    const [rustfs, git] = await Promise.all([startRustfs(), startGitServer()]);
    const log = openSync(resolve(root, "test-results/e2e/server.log"), "w");

    // Its own process group, so teardown stops the server and its worker together.
    const server = spawn("node", ["build/index.js"], {
        cwd: resolve(root, "apps/web"),
        detached: true,
        stdio: ["ignore", log, log],
        env: {
            ...process.env,
            NODE_ENV: "production",
            HOST: "127.0.0.1",
            PORT: String(port),
            ORIGIN: baseUrl,
            DATABASE_URL: databaseUrl,
            APP_URL: baseUrl,
            APP_SECRET,
            // A developer .env must not leak in: its Redis may be unreachable from here.
            // (Only override with empty values: varlock blocks responses that contain a
            // "sensitive" value, so a short one could blank every JS chunk.)
            REDIS_URL: "",
            // Tests act as different clients through x-forwarded-for, as if behind a proxy.
            ADDRESS_HEADER: "x-forwarded-for",
            NODE_EXTRA_CA_CERTS: rustfsCaFile,
        },
    });

    const exited = once(server, "exit");

    const teardown = async () => {
        const signal = (name: NodeJS.Signals) => {
            try {
                if (server.pid) process.kill(-server.pid, name);
            } catch {
                // Already exited.
            }
        };

        // adapter-node drains open streams on SIGTERM; never leave it running past teardown.
        signal("SIGTERM");
        const timer = setTimeout(() => signal("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);

        await sidecar.stop();
        await db.$client.end();
        await Promise.all([postgres.stop(), rustfs.container.stop(), git.container.stop()]);
    };

    try {
        await waitFor(`${baseUrl}/login`, 60_000);

        // The owner is also the instance admin. Signing in after the role change keeps the
        // cached session cookie from carrying the old role.
        await signUp(baseUrl, user);
        await db.$client.query(`UPDATE "user" SET role = 'admin' WHERE email = $1`, [user.email]);
        await signIn(baseUrl, user, storageState);
        const organizationId = await organizationOf(db, user.email);
        await seed(db, organizationId, sidecar.url);
        await seedBucket(baseUrl, rustfs.endpoint);

        // A plain member of the owner's organization, for permission checks. Sign-up gives
        // them their own organization; drop it so the owner's is the only one they see.
        await signUp(baseUrl, member);
        const ownOrganizationId = await organizationOf(db, member.email);
        await db.$client.query(
            `INSERT INTO member (id, organization_id, user_id, role, created_at)
             SELECT gen_random_uuid()::text, $1, id, 'member', now() FROM "user" WHERE email = $2`,
            [organizationId, member.email],
        );
        await db.$client.query("DELETE FROM organization WHERE id = $1", [ownOrganizationId]);
        await signIn(baseUrl, member, memberStorageState);

        process.env.E2E_BASE_URL = baseUrl;
        process.env.E2E_DATABASE_URL = databaseUrl;
        process.env.E2E_SIDECAR_URL = sidecar.url;
        process.env.E2E_RUSTFS_ENDPOINT = rustfs.endpoint;
    } catch (error) {
        await teardown();
        throw error;
    }

    return teardown;
}

async function signUp(baseUrl: string, account: { email: string; password: string; name: string }) {
    const api = await request.newContext({
        baseURL: baseUrl,
        extraHTTPHeaders: { origin: baseUrl, ...proxied },
    });

    const response = await api.post("/api/auth/sign-up/email", { data: account });

    if (!response.ok()) throw new Error(`Sign-up failed: ${await response.text()}`);
    await api.dispose();
}

async function signIn(
    baseUrl: string,
    account: { email: string; password: string },
    statePath: string,
) {
    const api = await request.newContext({
        baseURL: baseUrl,
        extraHTTPHeaders: { origin: baseUrl, ...proxied },
    });

    const response = await api.post("/api/auth/sign-in/email", {
        data: { email: account.email, password: account.password },
    });

    if (!response.ok()) throw new Error(`Sign-in failed: ${await response.text()}`);
    await api.storageState({ path: statePath });
    await api.dispose();
}

/**
 * An S3 connection to RustFS and the Shop project's `assets` bucket, created through the API
 * so the bucket row, its keys, and the real bucket all exist.
 */
async function seedBucket(baseUrl: string, endpoint: string) {
    const api = await request.newContext({
        baseURL: baseUrl,
        extraHTTPHeaders: { origin: baseUrl, ...proxied },
        storageState,
    });

    async function call(path: string, input: JsonObject) {
        const response = await api.post(`/rpc/${path}`, { data: { json: input } });

        if (!response.ok()) throw new Error(`${path} failed: ${await response.text()}`);

        return v.parse(v.object({ json: v.object({ id: v.string() }) }), await response.json())
            .json;
    }

    const connection = await call("s3/create", {
        name: "RustFS",
        connection: { provider: "rustfs", endpoint, ...rustfsRoot },
    });

    await call("buckets/create", {
        projectId: ids.shop,
        connectionId: connection.id,
        name: "assets",
        bucket: "assets",
    });
    await api.dispose();
}

/** The organization sign-up created for this account. */
async function organizationOf(db: ReturnType<typeof createDb>, email: string) {
    const [row] = (
        await db.$client.query<{ organization_id: string }>(
            `SELECT m.organization_id FROM member m JOIN "user" u ON u.id = m.user_id
             WHERE u.email = $1 ORDER BY m.created_at LIMIT 1`,
            [email],
        )
    ).rows;

    if (!row) throw new Error(`Sign-up did not create an organization for ${email}`);

    return row.organization_id;
}

async function seed(db: ReturnType<typeof createDb>, organizationId: string, sidecarUrl: string) {
    const sidecar = {
        organizationId,
        sidecarUrl,
        sidecarToken: "e2e-token",
        initializationStatus: "ready",
    };

    const app = "services:\n  app:\n    image: nginx:alpine\n";

    await db.insert(clusters).values([
        { id: ids.mainCluster, name: "Main", ...sidecar },
        { id: ids.otherCluster, name: "Other", ...sidecar },
        { id: ids.lonelyCluster, name: "Lonely", ...sidecar },
    ]);
    await db.insert(projects).values([
        { id: ids.shop, clusterId: ids.mainCluster, name: "Shop" },
        { id: ids.jobs, clusterId: ids.mainCluster, name: "Jobs" },
        { id: ids.elsewhere, clusterId: ids.otherCluster, name: "Elsewhere" },
        { id: ids.internal, clusterId: ids.mainCluster, name: "Internal", isInternal: true },
        { id: ids.lonely, clusterId: ids.lonelyCluster, name: "Lonely" },
    ]);
    // Staggered creation times keep list order deterministic.
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    await db.insert(resources).values([
        {
            id: ids.api,
            projectId: ids.shop,
            name: "api",
            draftSpec: apiSpec,
            settings: { env: "PORT=3000" },
            createdAt: at(1),
        },
        {
            id: ids.postgres,
            projectId: ids.shop,
            name: "postgres",
            draftSpec: "services:\n  db:\n    image: postgres:18\n",
            settings: { env: postgresEnv },
            createdAt: at(2),
        },
        {
            id: ids.worker,
            projectId: ids.jobs,
            name: "worker",
            draftSpec: "services:\n  jobs:\n    image: busybox\n",
            settings: { env: "QUEUE=jobs\n" },
            createdAt: at(4),
        },
        {
            id: ids.elsewhereResource,
            projectId: ids.elsewhere,
            name: "elsewhere",
            draftSpec: app,
            settings: { env: "SECRET=x\n" },
            createdAt: at(5),
        },
        {
            id: ids.monitoring,
            projectId: ids.internal,
            name: "monitoring",
            draftSpec: app,
            settings: { env: "SECRET=x\n" },
            createdAt: at(6),
        },
        {
            id: ids.solo,
            projectId: ids.lonely,
            name: "solo",
            draftSpec: app,
            settings: { env: "A=1\n" },
            createdAt: at(7),
        },
    ]);
}
