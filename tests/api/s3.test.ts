import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call, ORPCError } from "@orpc/server";
import { createDb } from "@stoat/db";
import { markBucketFailed, markBucketReady } from "@stoat/db/buckets";
import { clusters, projects, resources, s3Buckets, s3Connections } from "@stoat/db/schema/index";
import {
    resolveS3Connection,
    s3ConnectionInput,
    s3ConnectionTarget,
    type S3ConnectionInput,
} from "@stoat/s3";
import { decryptS3Secret, encryptS3Secret } from "@stoat/s3/secrets";
import * as runtime from "@stoat/workflows/runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as v from "valibot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { bucketsRouter } from "../../packages/api/src/routers/buckets";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { s3Router } from "../../packages/api/src/routers/s3";

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
        "https://10.0.0.5",
        "https://s3.example.com/bucket",
        "https://user:pass@s3.example.com",
    ])("rejects the non-public or non-root endpoint %s", (endpoint) => {
        expect(v.safeParse(s3ConnectionInput, { ...generic, endpoint }).success).toBe(false);
    });

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
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test'), ('member', 'Member', 'member@example.test')`,
        );

        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'owner'`,
        );

        const organizationId: string = membership.rows[0].organization_id;
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

    it("keeps a cluster with buckets so their keys can still be revoked", async () => {
        await expect(
            call(clusterRouter.deleteCluster, { clusterId }, { context: ownerContext }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });
});
