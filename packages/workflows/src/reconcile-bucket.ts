import type { Database } from "@stoat/db";
import {
    deleteBucketResource,
    getBucketWork,
    markBucketReady,
    type S3BucketRow,
} from "@stoat/db/buckets";
import {
    createS3Bucket,
    createS3BucketKey,
    deleteS3BucketIfEmpty,
    deleteS3BucketKey,
    encryptS3BucketCredentials,
    type S3ConnectionRecord,
} from "@stoat/s3";

async function provision(db: Database, bucket: S3BucketRow, connection: S3ConnectionRecord) {
    await createS3Bucket(connection, bucket.name);

    // Creating a key replaces any key left by a failed attempt, so retries stay idempotent.
    const key = await createS3BucketKey(connection, bucket.name, bucket.resourceId);

    await markBucketReady(
        db,
        bucket,
        key && {
            keyId: key.keyId,
            encryptedCredentials: encryptS3BucketCredentials(key.credentials, bucket.resourceId),
        },
    );
}

async function remove(db: Database, bucket: S3BucketRow, connection: S3ConnectionRecord) {
    // Revoked by name even when no key was recorded, so a half-provisioned key never outlives it.
    await deleteS3BucketKey(connection, bucket.resourceId);

    // A bucket holding data is kept in the provider; only the Stoat resource goes away.
    await deleteS3BucketIfEmpty(connection, bucket.name);
    await deleteBucketResource(db, bucket);
}

export async function reconcileBucket(
    db: Database,
    resourceId: string,
    requestId: string,
    signal: AbortSignal,
) {
    signal.throwIfAborted();
    const work = await getBucketWork(db, resourceId);

    // A newer request supersedes this job; its own job does the work.
    if (!work || work.bucket.requestedAt.toISOString() !== requestId) return;

    if (work.bucket.status === "provisioning") await provision(db, work.bucket, work.connection);
    else if (work.bucket.status === "deleting") await remove(db, work.bucket, work.connection);
}
