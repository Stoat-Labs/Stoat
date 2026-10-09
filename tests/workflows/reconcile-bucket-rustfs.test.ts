import { randomUUID } from "node:crypto";
import { Agent } from "node:https";
import { resolve } from "node:path";
import {
    CreateBucketCommand,
    HeadBucketCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusters, projects, resources, s3Buckets } from "@stoat/db/schema/index";
import { decryptS3BucketCredentials, type S3Credentials } from "@stoat/s3";
import * as s3Client from "@stoat/s3/client";
import { createRustfsKey, deleteRustfsKey } from "@stoat/s3/providers/rustfs";
import { reconcileBucket } from "@stoat/workflows/reconcile-bucket";
import * as runtime from "@stoat/workflows/runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { generate } from "selfsigned";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { bucketsRouter } from "../../packages/api/src/routers/buckets";
import { s3Router } from "../../packages/api/src/routers/s3";

const root: S3Credentials = { accessKey: "stoat-root", secretKey: "stoat-root-secret-key" };

// A revoked or replaced key is refused at authentication, before the bucket is even looked up.
const refused = { name: expect.stringMatching(/^(InvalidAccessKeyId|SignatureDoesNotMatch)$/u) };

describe("bucket reconciliation against RustFS", () => {
    const databaseName = `stoat_rustfs_${randomUUID().replaceAll("-", "")}`;
    const projectId = randomUUID();
    const signal = new AbortController().signal;
    const enqueue = vi.spyOn(runtime, "queueBucketReconcile").mockResolvedValue();
    let container: StartedTestContainer;
    let endpoint: string;
    let agent: Agent;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let owner: Context;

    // The production agent only reaches public addresses; this one trusts just the test certificate.
    function client(credentials: S3Credentials) {
        return new S3Client({
            endpoint,
            region: "us-east-1",
            forcePathStyle: true,
            credentials: {
                accessKeyId: credentials.accessKey,
                secretAccessKey: credentials.secretKey,
            },
            maxAttempts: 1,
            requestHandler: { httpsAgent: agent },
        });
    }

    async function bucketExists(bucket: string) {
        const s3 = client(root);

        try {
            await s3.send(new HeadBucketCommand({ Bucket: bucket }));

            return true;
        } catch (error) {
            if (error instanceof Error && error.name === "NotFound") return false;

            throw error;
        } finally {
            s3.destroy();
        }
    }

    async function put(credentials: S3Credentials, bucket: string, key: string) {
        const s3 = client(credentials);

        try {
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "stoat" }));
        } finally {
            s3.destroy();
        }
    }

    async function bucketRow(resourceId: string) {
        const [row] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, resourceId));

        return row;
    }

    // Runs the job the API would have queued for the bucket's current request.
    async function reconcile(resourceId: string) {
        const row = await bucketRow(resourceId);

        await reconcileBucket(db, resourceId, row!.requestedAt.toISOString(), signal);
    }

    async function createBucket(bucket: string) {
        const connection = await call(
            s3Router.create,
            {
                name: `RustFS ${randomUUID()}`,
                connection: { provider: "rustfs", endpoint, ...root },
            },
            { context: owner },
        );

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: bucket, bucket },
            { context: owner },
        );

        return id;
    }

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", "rustfs-integration-test-secret-at-least-32-bytes");

        const pems = await generate([{ name: "commonName", value: "localhost" }], {
            keySize: 2048,
            extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
        });

        container = await new GenericContainer("rustfs/rustfs:1.0.1")
            .withEnvironment({
                RUSTFS_ACCESS_KEY: root.accessKey,
                RUSTFS_SECRET_KEY: root.secretKey,
                RUSTFS_TLS_PATH: "/certs",
            })
            .withCopyContentToContainer([
                { content: pems.cert, target: "/certs/rustfs_cert.pem", mode: 0o644 },
                { content: pems.private, target: "/certs/rustfs_key.pem", mode: 0o644 },
            ])
            .withExposedPorts(9000)
            .withWaitStrategy(Wait.forHttp("/health", 9000).usingTls().allowInsecure())
            .start();

        // `localhost` rather than an IP: the endpoint policy refuses loopback literals.
        endpoint = `https://localhost:${container.getMappedPort(9000)}`;
        agent = new Agent({ ca: pems.cert });

        vi.spyOn(s3Client, "guardedHttpsAgent").mockReturnValue(agent);
        vi.spyOn(s3Client, "createS3Client").mockImplementation((target) =>
            client(target.credentials),
        );

        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'owner'`,
        );

        const organizationId: string = membership.rows[0].organization_id;

        // SAFETY: authorization reads only identity and active organization.
        owner = {
            db,
            session: { user: { id: "owner" }, session: { activeOrganizationId: organizationId } },
        } as Context;

        const clusterId = randomUUID();
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
    }, 120_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        agent?.destroy();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }

        await container?.stop();
    });

    beforeEach(() => {
        enqueue.mockClear();
    });

    it("creates the bucket with a key that can only reach that bucket", async () => {
        const resourceId = await createBucket("scoped");
        const other = client(root);

        await other.send(new CreateBucketCommand({ Bucket: "neighbour" }));
        other.destroy();
        await reconcile(resourceId);

        const row = await bucketRow(resourceId);
        expect(row).toMatchObject({ status: "ready", error: null, keyId: `stoat-${resourceId}` });
        expect(await bucketExists("scoped")).toBe(true);

        const key = decryptS3BucketCredentials(row!.encryptedCredentials!, resourceId);

        await put(key, "scoped", "hello.txt");
        await expect(put(key, "neighbour", "hello.txt")).rejects.toMatchObject({
            name: "AccessDenied",
        });
    });

    it("finishes a provisioning attempt that already created the bucket and a key", async () => {
        const resourceId = await createBucket("retried");
        const target = { endpoint, region: "us-east-1", forcePathStyle: true, credentials: root };

        // A crashed attempt left both behind before it could mark the bucket ready.
        // RustFS accepts a repeated CreateBucket, so this covers the key replacement, not BucketAlreadyOwnedByYou.
        const s3 = client(root);
        await s3.send(new CreateBucketCommand({ Bucket: "retried" }));
        s3.destroy();
        const abandoned = await createRustfsKey(target, "retried", `stoat-${resourceId}`);

        await reconcile(resourceId);

        const row = await bucketRow(resourceId);
        expect(row).toMatchObject({ status: "ready" });

        const key = decryptS3BucketCredentials(row!.encryptedCredentials!, resourceId);
        expect(key.secretKey).not.toBe(abandoned.credentials.secretKey);
        await put(key, "retried", "hello.txt");
        await expect(put(abandoned.credentials, "retried", "stale.txt")).rejects.toMatchObject(
            refused,
        );
    });

    it("deletes an empty bucket, revokes its key, and removes the resource", async () => {
        const resourceId = await createBucket("emptied");
        await reconcile(resourceId);
        const ready = await bucketRow(resourceId);
        const key = decryptS3BucketCredentials(ready!.encryptedCredentials!, resourceId);

        await call(bucketsRouter.remove, { projectId, resourceId }, { context: owner });
        await reconcile(resourceId);

        expect(await bucketExists("emptied")).toBe(false);
        expect(await db.select().from(resources).where(eq(resources.id, resourceId))).toEqual([]);
        await expect(put(key, "emptied", "after.txt")).rejects.toMatchObject(refused);
    });

    it("keeps a bucket that holds data while still removing the resource and key", async () => {
        const resourceId = await createBucket("kept");
        await reconcile(resourceId);
        const ready = await bucketRow(resourceId);
        const key = decryptS3BucketCredentials(ready!.encryptedCredentials!, resourceId);

        await put(root, "kept", "data.txt");
        await call(bucketsRouter.remove, { projectId, resourceId }, { context: owner });
        await reconcile(resourceId);

        expect(await bucketExists("kept")).toBe(true);
        expect(await db.select().from(resources).where(eq(resources.id, resourceId))).toEqual([]);
        await expect(put(key, "kept", "after.txt")).rejects.toMatchObject(refused);
    });

    it("treats revoking a key that was never created as done", async () => {
        const target = { endpoint, region: "us-east-1", forcePathStyle: true, credentials: root };

        await expect(deleteRustfsKey(target, `stoat-${randomUUID()}`)).resolves.toBeUndefined();
    });
});
