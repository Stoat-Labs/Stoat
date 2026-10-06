import type { Database } from "@stoat/db";
import { readyBuckets, setBucketMetadata } from "@stoat/db/buckets";
import { getS3BucketStats, s3BucketTarget } from "@stoat/s3";

// Runs once per HealthCheck tick (see HEALTH_CHECK_CRON in runtime.ts).
// Throwing fails this tick only; the next tick runs regardless.
export async function runHealthCheck(db: Database, signal: AbortSignal) {
    // TODO: cluster sidecar reachability, S3 connection tests.
    signal.throwIfAborted();
    await measureBuckets(db, signal);
}

async function measureBuckets(db: Database, signal: AbortSignal) {
    for (const { bucket, connection } of await readyBuckets(db)) {
        signal.throwIfAborted();

        try {
            const target = s3BucketTarget(
                connection,
                bucket.resourceId,
                bucket.encryptedCredentials,
            );

            const stats = await getS3BucketStats(target, bucket.name, signal);

            await setBucketMetadata(db, bucket.resourceId, {
                size: stats.size,
                objects: stats.objects,
                lastModifiedAt: stats.lastModified?.toISOString() ?? null,
                measuredAt: new Date().toISOString(),
            });
        } catch (error) {
            // One unreachable provider must not stop the other buckets; the last snapshot stays.
            signal.throwIfAborted();
            console.error(`Measuring bucket ${bucket.name} failed:`, error);
        }
    }
}
