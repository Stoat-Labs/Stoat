import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { clusters, projects, resources, s3Buckets, s3Connections } from "@stoat/db/schema/index";
import {
    listS3Objects,
    s3BucketName,
    s3BucketTarget,
    s3DownloadUrl,
    s3FailureMessage,
    s3Providers,
    setS3BucketQuota,
    type S3Target,
} from "@stoat/s3";
import { queueBucketReconcile } from "@stoat/workflows/runtime";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationAdminProcedure, organizationProcedure } from "..";

const id = v.pipe(v.string(), v.uuid());

const resourceInput = { projectId: id, resourceId: id };

const objectKey = v.pipe(v.string(), v.maxLength(4096));

async function getBucket(
    db: Database,
    organizationId: string,
    projectId: string,
    resourceId: string,
) {
    const [row] = await db
        .select({ bucket: s3Buckets, connection: s3Connections, resource: resources })
        .from(s3Buckets)
        .innerJoin(resources, eq(s3Buckets.resourceId, resources.id))
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .innerJoin(s3Connections, eq(s3Buckets.connectionId, s3Connections.id))
        .where(
            and(
                eq(resources.id, resourceId),
                eq(projects.id, projectId),
                sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        )
        .limit(1);

    if (!row) throw new ORPCError("NOT_FOUND", { message: "Bucket not found." });

    return row;
}

type BucketRow = Awaited<ReturnType<typeof getBucket>>;

function bucketTarget({ bucket, connection }: BucketRow): S3Target {
    return s3BucketTarget(connection, bucket.resourceId, bucket.encryptedCredentials);
}

function readyTarget(row: BucketRow) {
    if (row.bucket.status !== "ready")
        throw new ORPCError("BAD_REQUEST", { message: "The bucket is not ready yet." });

    return bucketTarget(row);
}

function badGateway(error: Error) {
    return new ORPCError("BAD_GATEWAY", { message: s3FailureMessage(error) });
}

// Re-queues the bucket's job with a fresh request, but only from the allowed statuses.
async function request(
    db: Database,
    row: BucketRow,
    status: "provisioning" | "deleting",
    from: ("ready" | "failed")[],
) {
    const requestedAt = new Date();

    const [updated] = await db
        .update(s3Buckets)
        .set({ status, requestedAt, error: null })
        .where(
            and(eq(s3Buckets.resourceId, row.bucket.resourceId), inArray(s3Buckets.status, from)),
        )
        .returning({ resourceId: s3Buckets.resourceId });

    if (!updated)
        throw new ORPCError("CONFLICT", {
            message: "The bucket is busy. Wait for the current operation to finish.",
        });

    await queueBucketReconcile(row.bucket.resourceId, requestedAt).catch(() => {});

    return { status };
}

export const bucketsRouter = {
    create: organizationAdminProcedure
        .input(
            v.object({
                projectId: id,
                connectionId: id,
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                bucket: s3BucketName,
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [project] = await db
                .select({ id: projects.id })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

            const [connection] = await db
                .select({ id: s3Connections.id })
                .from(s3Connections)
                .where(
                    and(
                        eq(s3Connections.id, input.connectionId),
                        eq(s3Connections.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!connection)
                throw new ORPCError("NOT_FOUND", { message: "S3 connection not found." });

            const [duplicate] = await db
                .select({ resourceId: s3Buckets.resourceId })
                .from(s3Buckets)
                .where(
                    and(
                        eq(s3Buckets.connectionId, connection.id),
                        eq(s3Buckets.name, input.bucket),
                    ),
                )
                .limit(1);

            if (duplicate)
                throw new ORPCError("CONFLICT", {
                    message: "This connection already has a bucket with that name.",
                });

            const resourceId = randomUUID();
            const requestedAt = new Date();

            await db.transaction(async (tx) => {
                await tx.insert(resources).values({
                    id: resourceId,
                    name: input.name,
                    description: input.description || null,
                    type: "bucket",
                    projectId: project.id,
                });
                await tx.insert(s3Buckets).values({
                    resourceId,
                    connectionId: connection.id,
                    name: input.bucket,
                    status: "provisioning",
                    requestedAt,
                });
            });

            // The bucket row is the durable outbox if enqueue is temporarily unavailable.
            await queueBucketReconcile(resourceId, requestedAt).catch(() => {});

            return { id: resourceId };
        }),
    get: organizationProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const { bucket, connection } = await getBucket(
                db,
                organizationId,
                input.projectId,
                input.resourceId,
            );

            return {
                name: bucket.name,
                status: bucket.status,
                error: bucket.error,
                scopedKey: Boolean(bucket.keyId),
                usage: bucket.metadata,
                quota: bucket.quota,
                enforcedQuota: s3Providers[connection.provider].enforcedQuota,
                connection: {
                    id: connection.id,
                    name: connection.name,
                    provider: connection.provider,
                    providerName: s3Providers[connection.provider].name,
                    endpoint: connection.endpoint,
                    region: connection.region,
                    forcePathStyle: connection.forcePathStyle,
                },
            };
        }),
    // Separate from `get` so secrets are only fetched when an admin asks to see them.
    credentials: organizationAdminProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const row = await getBucket(db, organizationId, input.projectId, input.resourceId);

            return readyTarget(row).credentials;
        }),
    // The provider is updated first, so a failed save never claims a limit it does not enforce.
    setQuota: organizationAdminProcedure
        .input(
            v.object({
                ...resourceInput,
                quota: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const { bucket, connection } = await getBucket(
                db,
                organizationId,
                input.projectId,
                input.resourceId,
            );

            if (bucket.status !== "ready")
                throw new ORPCError("BAD_REQUEST", { message: "The bucket is not ready yet." });

            await setS3BucketQuota(connection, bucket.name, input.quota).catch((error) => {
                throw badGateway(error instanceof Error ? error : new Error("S3 request failed."));
            });

            await db
                .update(s3Buckets)
                .set({ quota: input.quota })
                .where(eq(s3Buckets.resourceId, bucket.resourceId));

            return { quota: input.quota };
        }),
    retry: organizationAdminProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) =>
            request(
                db,
                await getBucket(db, organizationId, input.projectId, input.resourceId),
                "provisioning",
                ["failed"],
            ),
        ),
    remove: organizationAdminProcedure
        .input(v.object(resourceInput))
        .handler(async ({ context: { db, organizationId }, input }) =>
            request(
                db,
                await getBucket(db, organizationId, input.projectId, input.resourceId),
                "deleting",
                ["ready", "failed"],
            ),
        ),
    listFiles: organizationProcedure
        .input(
            v.object({
                ...resourceInput,
                prefix: v.optional(objectKey, ""),
                cursor: v.optional(v.pipe(v.string(), v.maxLength(8192))),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const row = await getBucket(db, organizationId, input.projectId, input.resourceId);

            return listS3Objects(
                readyTarget(row),
                row.bucket.name,
                input.prefix,
                input.cursor,
            ).catch((error) => {
                throw badGateway(error instanceof Error ? error : new Error("S3 request failed."));
            });
        }),
    downloadUrl: organizationProcedure
        .input(v.object({ ...resourceInput, key: v.pipe(objectKey, v.minLength(1)) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const row = await getBucket(db, organizationId, input.projectId, input.resourceId);

            return {
                url: await s3DownloadUrl(readyTarget(row), row.bucket.name, input.key).catch(
                    (error) => {
                        throw badGateway(
                            error instanceof Error ? error : new Error("S3 request failed."),
                        );
                    },
                ),
            };
        }),
};
