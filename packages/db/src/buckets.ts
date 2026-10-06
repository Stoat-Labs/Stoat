import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./index";
import {
    resources,
    s3Buckets,
    s3Connections,
    type S3BucketMetadata,
    type S3BucketStatus,
} from "./schema";

export type S3BucketRow = typeof s3Buckets.$inferSelect;

// Every write is tied to the request that produced it, so a stale job can never
// overwrite a newer retry or deletion.
function current(resourceId: string, requestedAt: Date, status: S3BucketStatus) {
    return and(
        eq(s3Buckets.resourceId, resourceId),
        eq(s3Buckets.requestedAt, requestedAt),
        eq(s3Buckets.status, status),
    );
}

export async function getBucketWork(db: Database, resourceId: string) {
    const [row] = await db
        .select({ bucket: s3Buckets, connection: s3Connections })
        .from(s3Buckets)
        .innerJoin(s3Connections, eq(s3Buckets.connectionId, s3Connections.id))
        .where(eq(s3Buckets.resourceId, resourceId))
        .limit(1);

    return row ?? null;
}

export async function markBucketReady(
    db: Database,
    bucket: S3BucketRow,
    key: { keyId: string; encryptedCredentials: string } | null,
) {
    const updated = await db
        .update(s3Buckets)
        .set({
            status: "ready",
            error: null,
            keyId: key?.keyId ?? null,
            encryptedCredentials: key?.encryptedCredentials ?? null,
        })
        .where(current(bucket.resourceId, bucket.requestedAt, "provisioning"))
        .returning({ resourceId: s3Buckets.resourceId });

    return updated.length > 0;
}

export async function markBucketFailed(
    db: Database,
    resourceId: string,
    requestedAt: Date,
    error: string,
) {
    await db
        .update(s3Buckets)
        .set({ status: "failed", error })
        .where(
            and(
                eq(s3Buckets.resourceId, resourceId),
                eq(s3Buckets.requestedAt, requestedAt),
                inArray(s3Buckets.status, ["provisioning", "deleting"]),
            ),
        );
}

// Removing the resource cascades to the bucket row.
export async function deleteBucketResource(db: Database, bucket: S3BucketRow) {
    await db.transaction(async (tx) => {
        const [locked] = await tx
            .select({ resourceId: s3Buckets.resourceId })
            .from(s3Buckets)
            .where(current(bucket.resourceId, bucket.requestedAt, "deleting"))
            .for("update");

        if (locked) await tx.delete(resources).where(eq(resources.id, bucket.resourceId));
    });
}

export async function readyBuckets(db: Database) {
    return db
        .select({ bucket: s3Buckets, connection: s3Connections })
        .from(s3Buckets)
        .innerJoin(s3Connections, eq(s3Buckets.connectionId, s3Connections.id))
        .where(eq(s3Buckets.status, "ready"));
}

// Only ready buckets take a snapshot, so a measurement never lands on one being deleted.
export async function setBucketMetadata(
    db: Database,
    resourceId: string,
    metadata: S3BucketMetadata,
) {
    await db
        .update(s3Buckets)
        .set({ metadata })
        .where(and(eq(s3Buckets.resourceId, resourceId), eq(s3Buckets.status, "ready")));
}

export async function pendingBucketRequests(db: Database) {
    return db
        .select({ resourceId: s3Buckets.resourceId, requestedAt: s3Buckets.requestedAt })
        .from(s3Buckets)
        .where(inArray(s3Buckets.status, ["provisioning", "deleting"]));
}
