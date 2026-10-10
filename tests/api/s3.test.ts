import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call, ORPCError } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    markBucketFailed,
    markBucketReady,
    readyBuckets,
    setBucketMetadata,
} from "@stoat/db/buckets";
import { clusters, projects, resources, s3Buckets, s3Connections } from "@stoat/db/schema/index";
import {
    resolveS3Connection,
    s3ConnectionInput,
    s3ConnectionTarget,
    type S3ConnectionInput,
} from "@stoat/s3";
import { getR2BucketUsage } from "@stoat/s3/providers/r2";
import { parseRustfsBucketUsage } from "@stoat/s3/providers/rustfs";
import { decryptS3Secret, encryptS3Secret } from "@stoat/s3/secrets";
import { reconcileBucket } from "@stoat/workflows/reconcile-bucket";
import * as runtime from "@stoat/workflows/runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as v from "valibot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { bucketsRouter } from "../../packages/api/src/routers/buckets";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { s3Router } from "../../packages/api/src/routers/s3";
import { insertUserWithOrganization } from "../users";

const generic: S3ConnectionInput = {
    provider: "generic",
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    forcePathStyle: true,
    accessKey: "stoat-test-access",
    secretKey: "stoat-test-secret-never-return",
};

describe("S3 secrets and input", () => {
    beforeAll(() => {
        vi.stubEnv("APP_SECRET", "s3-unit-test-secret-at-least-32-bytes");
    });

    afterAll(() => {
        vi.unstubAllEnvs();
    });

    it("binds every secret to the row it was encrypted for", () => {
        const scope = { kind: "bucket-credentials", resourceId: "a" } as const;
        const envelope = encryptS3Secret("value", scope);

        expect(decryptS3Secret(envelope, scope)).toBe("value");
        expect(() => decryptS3Secret(envelope, { ...scope, resourceId: "b" })).toThrow();
        expect(() =>
            decryptS3Secret(envelope, {
                kind: "connection-credentials",
                organizationId: "a",
                connectionId: "a",
            }),
        ).toThrow();
    });

    it.each([
        "http://s3.example.com",
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://s3.example.com/bucket",
        "https://user:pass@s3.example.com",
    ])("rejects the unsafe or non-root endpoint %s", (endpoint) => {
        expect(v.safeParse(s3ConnectionInput, { ...generic, endpoint }).success).toBe(false);
    });

    it.each(["https://10.0.0.5", "https://192.168.1.20:9000"])(
        "accepts the private network endpoint %s",
        (endpoint) => {
            expect(v.safeParse(s3ConnectionInput, { ...generic, endpoint }).success).toBe(true);
        },
    );

    it("requires a Cloudflare account ID for R2", () => {
        expect(
            v.safeParse(s3ConnectionInput, { provider: "r2", accountId: "not-an-id" }).success,
        ).toBe(false);
        expect(
            v.safeParse(s3ConnectionInput, { provider: "r2", accountId: "a".repeat(32) }).success,
        ).toBe(true);
    });

    it("stores generic keys encrypted and restores the same target", async () => {
        const columns = await resolveS3Connection(generic, "org", "connection");

        expect(columns.encryptedCredentials).not.toContain("stoat-test-secret");
        expect(columns).toMatchObject({ providerAccountId: null, encryptedApiToken: null });
        expect(s3ConnectionTarget({ ...columns, id: "connection", organizationId: "org" })).toEqual(
            {
                endpoint: "https://s3.example.com",
                region: "us-east-1",
                forcePathStyle: true,
                credentials: { accessKey: "stoat-test-access", secretKey: generic.secretKey },
            },
        );
    });
});

describe("provider bucket usage", () => {
    afterAll(() => {
        vi.unstubAllGlobals();
    });

    function rustfsBody(lastUpdate: { secs_since_epoch: number } | null) {
        return JSON.stringify({
            last_update: lastUpdate && { ...lastUpdate, nanos_since_epoch: 275864172 },
            buckets_usage: { media: { size: 2048, objects_count: 3, versions_count: 3 } },
        });
    }

    it("reads RustFS usage with the scanner's snapshot time in seconds", () => {
        expect(
            parseRustfsBucketUsage(rustfsBody({ secs_since_epoch: 1791300780 }), "media"),
        ).toEqual({ size: 2048, objects: 3, measuredAt: new Date("2026-10-06T15:33:00.000Z") });
    });

    it("treats a bucket the RustFS scanner has not reached as unmeasured, not empty", () => {
        const scanned = rustfsBody({ secs_since_epoch: 1791300780 });

        expect(parseRustfsBucketUsage(scanned, "uploads")).toBeNull();
        expect(parseRustfsBucketUsage(rustfsBody(null), "media")).toBeNull();
        expect(() => parseRustfsBucketUsage("{}", "media")).toThrow();
    });

    type AnalyticsResponse = {
        data: {
            viewer: {
                accounts: {
                    r2StorageAdaptiveGroups: {
                        max: { objectCount: number; payloadSize: number };
                        dimensions: { datetime: string };
                    }[];
                }[];
            };
        } | null;
        errors?: { message: string }[];
    };

    function analytics(body: AnalyticsResponse) {
        const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
            Response.json(body),
        );

        vi.stubGlobal("fetch", fetch);

        return fetch;
    }

    it("reads the newest R2 storage sample for the bucket", async () => {
        const fetch = analytics({
            data: {
                viewer: {
                    accounts: [
                        {
                            r2StorageAdaptiveGroups: [
                                {
                                    max: { objectCount: 7, payloadSize: 4096 },
                                    dimensions: { datetime: "2026-10-06T15:00:00Z" },
                                },
                            ],
                        },
                    ],
                },
            },
        });

        expect(await getR2BucketUsage("account", "token", "media")).toEqual({
            size: 4096,
            objects: 7,
            measuredAt: new Date("2026-10-06T15:00:00Z"),
        });

        const [, init] = fetch.mock.calls[0]!;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        expect(JSON.parse(String(init?.body)).variables).toMatchObject({
            accountTag: "account",
            filter: { bucketName: "media" },
        });
    });

    it("treats an R2 bucket without recent samples as unmeasured", async () => {
        analytics({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [] }] } } });

        expect(await getR2BucketUsage("account", "token", "media")).toBeNull();
    });

    it("fails loudly when the R2 token cannot read analytics", async () => {
        // GraphQL reports permission problems with a 200 and an errors array.
        analytics({ data: null, errors: [{ message: "not authorized for that account" }] });

        await expect(getR2BucketUsage("account", "token", "media")).rejects.toThrow(
            "not authorized",
        );
    });
});

describe("S3 connections and buckets API", () => {
    const databaseName = `stoat_s3_api_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let ownerContext: Context;
    let memberContext: Context;
    const enqueue = vi.spyOn(runtime, "queueBucketReconcile").mockResolvedValue();

    function context(userId: string, organizationId: string) {
        // SAFETY: authorization reads only identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", "s3-integration-test-secret-at-least-32-bytes");
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(
            db,
            "owner",
            "Owner",
            "owner@example.test",
        );

        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('member', 'Member', 'member@example.test')`,
        );
        await db.$client.query(
            `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, 'member', 'member', now())`,
            [randomUUID(), organizationId],
        );
        ownerContext = context("owner", organizationId);
        memberContext = context("member", organizationId);
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
    }, 30_000);

    afterAll(async () => {
        enqueue.mockRestore();
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    beforeEach(() => {
        enqueue.mockClear();
    });

    async function createConnection(name = `Storage ${randomUUID()}`) {
        return call(s3Router.create, { name, connection: generic }, { context: ownerContext });
    }

    it("never returns credentials and keeps them on edits without secrets", async () => {
        const created = await createConnection();

        expect(JSON.stringify(created)).not.toContain(generic.secretKey);
        expect(created).toMatchObject({ provider: "generic", endpoint: generic.endpoint });

        const updated = await call(
            s3Router.update,
            {
                connectionId: created.id,
                version: created.version,
                name: "Renamed",
                connection: { ...generic, accessKey: undefined, secretKey: undefined },
            },
            { context: ownerContext },
        );

        expect(updated).toMatchObject({ name: "Renamed", version: created.version + 1 });
    });

    it("refuses to point stored secrets at another endpoint", async () => {
        const created = await createConnection();

        await expect(
            call(
                s3Router.update,
                {
                    connectionId: created.id,
                    version: created.version,
                    name: created.name,
                    connection: {
                        ...generic,
                        endpoint: "https://attacker.example.com",
                        accessKey: undefined,
                        secretKey: undefined,
                    },
                },
                { context: ownerContext },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("lets only admins manage connections", async () => {
        await expect(
            call(
                s3Router.create,
                { name: "Member", connection: generic },
                { context: memberContext },
            ),
        ).rejects.toBeInstanceOf(ORPCError);
    });

    it("provisions a bucket resource through the durable outbox", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Uploads", bucket: "uploads" },
            { context: ownerContext },
        );

        const [resource] = await db.select().from(resources).where(eq(resources.id, id));
        const [bucket] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));

        expect(resource).toMatchObject({ type: "bucket", projectId, name: "Uploads" });
        expect(bucket).toMatchObject({ status: "provisioning", name: "uploads" });
        expect(enqueue).toHaveBeenCalledWith(id, bucket!.requestedAt);

        await expect(
            call(
                bucketsRouter.create,
                { projectId, connectionId: connection.id, name: "Again", bucket: "uploads" },
                { context: ownerContext },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // A connection with buckets keeps the credentials needed to revoke their keys.
        await expect(
            call(
                s3Router.remove,
                { connectionId: connection.id, version: connection.version },
                { context: ownerContext },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("only deletes settled buckets, and stale jobs cannot overwrite newer requests", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Media", bucket: "media" },
            { context: ownerContext },
        );

        const input = { projectId, resourceId: id };

        await expect(
            call(bucketsRouter.remove, input, { context: ownerContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const [provisioning] = await db
            .select()
            .from(s3Buckets)
            .where(eq(s3Buckets.resourceId, id));

        await markBucketFailed(db, id, provisioning!.requestedAt, "Unable to reach S3.");

        expect(await call(bucketsRouter.get, input, { context: memberContext })).toMatchObject({
            status: "failed",
            error: "Unable to reach S3.",
        });

        await call(bucketsRouter.remove, input, { context: ownerContext });

        const [deleting] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));
        expect(deleting).toMatchObject({ status: "deleting" });
        expect(enqueue).toHaveBeenLastCalledWith(id, deleting!.requestedAt);

        // The superseded provisioning job finishing late must not resurrect the bucket.
        expect(await markBucketReady(db, provisioning!, null)).toBe(false);
        const [after] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));
        expect(after).toMatchObject({ status: "deleting" });
    });

    it("stores a display-only limit for providers that cannot enforce one", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Limited", bucket: "limited" },
            { context: ownerContext },
        );

        const input = { projectId, resourceId: id };

        await expect(
            call(bucketsRouter.setQuota, { ...input, quota: 1024 }, { context: ownerContext }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });

        const [provisioning] = await db
            .select()
            .from(s3Buckets)
            .where(eq(s3Buckets.resourceId, id));

        await markBucketReady(db, provisioning!, null);

        await expect(
            call(bucketsRouter.setQuota, { ...input, quota: 1024 }, { context: memberContext }),
        ).rejects.toBeInstanceOf(ORPCError);

        // Generic S3 has no quota API, so this never reaches the provider.
        await call(bucketsRouter.setQuota, { ...input, quota: 1024 }, { context: ownerContext });

        expect(await call(bucketsRouter.get, input, { context: memberContext })).toMatchObject({
            quota: 1024,
            enforcedQuota: false,
            usage: null,
        });

        await call(bucketsRouter.setQuota, { ...input, quota: null }, { context: ownerContext });

        expect(await call(bucketsRouter.get, input, { context: memberContext })).toMatchObject({
            quota: null,
        });
    });

    it("never writes a usage snapshot onto a bucket that is not ready", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Measured", bucket: "measured" },
            { context: ownerContext },
        );

        const snapshot = { size: 10, objects: 1, measuredAt: "2026-10-06T15:33:00.000Z" };

        const metadata = async () =>
            (await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id)))[0]?.metadata;

        await setBucketMetadata(db, id, snapshot);
        expect(await metadata()).toBeNull();

        const [provisioning] = await db
            .select()
            .from(s3Buckets)
            .where(eq(s3Buckets.resourceId, id));

        await markBucketReady(db, provisioning!, null);
        await setBucketMetadata(db, id, snapshot);
        expect(await metadata()).toEqual(snapshot);

        // A measurement that finishes after deletion starts must not touch the row.
        await call(bucketsRouter.remove, { projectId, resourceId: id }, { context: ownerContext });
        await setBucketMetadata(db, id, { ...snapshot, size: 99 });
        expect(await metadata()).toEqual(snapshot);
    });

    it("scopes a manual health check to the cluster's own buckets", async () => {
        const otherClusterId = randomUUID();
        const otherProjectId = randomUUID();

        await db.insert(clusters).values({
            id: otherClusterId,
            name: "Other cluster",
            sidecarUrl: "http://other-sidecar.test",
            sidecarToken: "secret",
            organizationId: ownerContext.session!.session.activeOrganizationId!,
        });
        await db.insert(projects).values({
            id: otherProjectId,
            name: "Other",
            clusterId: otherClusterId,
        });

        const connection = await createConnection();

        async function readyBucket(project: string, bucket: string) {
            const { id } = await call(
                bucketsRouter.create,
                { projectId: project, connectionId: connection.id, name: bucket, bucket },
                { context: ownerContext },
            );

            const [row] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));

            await markBucketReady(db, row!, null);

            return id;
        }

        const here = await readyBucket(projectId, "scoped-here");
        const there = await readyBucket(otherProjectId, "scoped-there");

        const scoped = (await readyBuckets(db, otherClusterId)).map(
            ({ bucket }) => bucket.resourceId,
        );

        const everywhere = (await readyBuckets(db)).map(({ bucket }) => bucket.resourceId);

        expect(scoped).toEqual([there]);
        expect(everywhere).toEqual(expect.arrayContaining([here, there]));
    });

    it("lets only admins queue a health check, and only for their own clusters", async () => {
        const queue = vi.spyOn(runtime, "queueClusterHealthCheck").mockResolvedValue();

        try {
            await call(clusterRouter.runHealthCheck, { clusterId }, { context: ownerContext });
            expect(queue).toHaveBeenCalledWith(clusterId);

            await expect(
                call(clusterRouter.runHealthCheck, { clusterId }, { context: memberContext }),
            ).rejects.toBeInstanceOf(ORPCError);

            const [{ id: strangerOrganization }] = (
                await db.$client.query(
                    `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Stranger', $1, now()) RETURNING id`,
                    [randomUUID()],
                )
            ).rows;

            await db.$client.query(
                `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, 'member', 'owner', now())`,
                [randomUUID(), strangerOrganization],
            );

            await expect(
                call(
                    clusterRouter.runHealthCheck,
                    { clusterId },
                    { context: context("member", strangerOrganization) },
                ),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(queue).toHaveBeenCalledTimes(1);
        } finally {
            queue.mockRestore();
        }
    });

    it("hides credentials from members", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Private", bucket: "private" },
            { context: ownerContext },
        );

        await expect(
            call(
                bucketsRouter.credentials,
                { projectId, resourceId: id },
                { context: memberContext },
            ),
        ).rejects.toBeInstanceOf(ORPCError);
    });

    it("lets an organization cascade through its connections and buckets", async () => {
        const [{ id: organizationId }] = (
            await db.$client.query(
                `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Doomed', $1, now()) RETURNING id`,
                [randomUUID()],
            )
        ).rows;

        const doomedCluster = randomUUID();
        const doomedProject = randomUUID();
        const resourceId = randomUUID();
        const connection = await resolveS3Connection(generic, organizationId, randomUUID());
        const connectionId = randomUUID();

        await db.insert(clusters).values({
            id: doomedCluster,
            name: "Doomed",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({
            id: doomedProject,
            name: "Doomed",
            clusterId: doomedCluster,
        });
        await db
            .insert(s3Connections)
            .values({ ...connection, id: connectionId, organizationId, name: "Doomed" });
        await db
            .insert(resources)
            .values({ id: resourceId, name: "Doomed", type: "bucket", projectId: doomedProject });
        await db.insert(s3Buckets).values({
            resourceId,
            connectionId,
            name: "doomed",
            status: "ready",
            requestedAt: new Date(),
        });

        await db.$client.query("DELETE FROM organization WHERE id = $1", [organizationId]);

        expect(
            await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, resourceId)),
        ).toEqual([]);
    });

    it("lets a superseded reconcile job finish without touching the provider or the row", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Stale", bucket: "stale" },
            { context: ownerContext },
        );

        const [before] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));
        const staleRequest = new Date(before!.requestedAt.getTime() - 1_000).toISOString();
        const signal = new AbortController().signal;

        // The connection's endpoint is not reachable, so any provider call would reject.
        await reconcileBucket(db, id, staleRequest, signal);
        await reconcileBucket(db, randomUUID(), before!.requestedAt.toISOString(), signal);

        const [after] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));
        expect(after).toEqual(before);
    });

    it("leaves a settled bucket alone when its own job is redelivered", async () => {
        const connection = await createConnection();

        const { id } = await call(
            bucketsRouter.create,
            { projectId, connectionId: connection.id, name: "Settled", bucket: "settled" },
            { context: ownerContext },
        );

        const [provisioning] = await db
            .select()
            .from(s3Buckets)
            .where(eq(s3Buckets.resourceId, id));

        await markBucketReady(db, provisioning!, null);
        await reconcileBucket(
            db,
            id,
            provisioning!.requestedAt.toISOString(),
            new AbortController().signal,
        );

        const [after] = await db.select().from(s3Buckets).where(eq(s3Buckets.resourceId, id));
        expect(after).toMatchObject({ status: "ready" });
    });

    it("does no reconcile work once the job is interrupted", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            reconcileBucket(db, randomUUID(), new Date().toISOString(), controller.signal),
        ).rejects.toThrow();
    });

    it("keeps a cluster with buckets so their keys can still be revoked", async () => {
        await expect(
            call(clusterRouter.deleteCluster, { clusterId }, { context: ownerContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });
});
