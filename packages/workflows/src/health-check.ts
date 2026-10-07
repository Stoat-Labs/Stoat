import type { Database } from "@stoat/db";
import { readyBuckets, setBucketMetadata } from "@stoat/db/buckets";
import { getS3BucketUsage } from "@stoat/s3";

// Runs once per HealthCheck tick (see HEALTH_CHECK_CRON in runtime.ts).
// Throwing fails this tick only; the next tick runs regardless.
// Without a cluster it checks every cluster.
export async function runHealthCheck(db: Database, signal: AbortSignal, clusterId?: string) {
    // TODO: cluster sidecar reachability, S3 connection tests.
    signal.throwIfAborted();
    await measureBuckets(db, signal, clusterId);
}

async function measureBuckets(db: Database, signal: AbortSignal, clusterId?: string) {
    for (const { bucket, connection } of await readyBuckets(db, clusterId)) {
        signal.throwIfAborted();

        try {
            const usage = await getS3BucketUsage(connection, bucket.name, signal);

            // The provider has not measured this bucket yet; keep the last snapshot.
            if (!usage) continue;

            await setBucketMetadata(db, bucket.resourceId, {
                size: usage.size,
                objects: usage.objects,
                measuredAt: usage.measuredAt.toISOString(),
            });
        } catch (error) {
            // One unreachable provider must not stop the other buckets; the last snapshot stays.
            signal.throwIfAborted();
            console.error(`Measuring bucket ${bucket.name} failed:`, error);
        }
    }
}
