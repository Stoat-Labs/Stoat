import { Job } from "effect-mq";
import { Schema } from "effect";

const payload = Schema.Struct({
    clusterId: Schema.String,
    // InitializationRequestedAt ISO string. Makes the job id deterministic
    // per request so retries and outbox recovery are idempotent.
    requestId: Schema.String,
});

export const InitializeCluster: Job.Job<
    "InitializeCluster",
    typeof payload,
    Schema.Void,
    Schema.Never
> = Job.make("InitializeCluster", {
    payload,
    success: Schema.Void,
    idempotencyKey: ({ clusterId, requestId }) => `${clusterId}:${requestId}`,
    metadata: ({ clusterId, requestId }) => ({
        clusterId,
        requestId,
    }),
    queue: "initialize",
    defaults: {
        attempts: 5,
        backoff: { type: "exponential", delay: "30 seconds" },
        timeout: "15 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});

const resourcePayload = Schema.Struct({ deploymentId: Schema.String });

export const DeployResource: Job.Job<
    "DeployResource",
    typeof resourcePayload,
    Schema.Void,
    Schema.Never
> = Job.make("DeployResource", {
    payload: resourcePayload,
    success: Schema.Void,
    idempotencyKey: ({ deploymentId }) => deploymentId,
    queue: "deploy",
    defaults: {
        attempts: 5,
        backoff: { type: "exponential", delay: "30 seconds" },
        timeout: "15 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});

const bucketPayload = Schema.Struct({
    resourceId: Schema.String,
    // The bucket row's requested_at ISO string; each retry or deletion is a new job.
    requestId: Schema.String,
});

// Provisions or deletes a bucket resource, depending on the bucket row's status.
export const ReconcileBucket: Job.Job<
    "ReconcileBucket",
    typeof bucketPayload,
    Schema.Void,
    Schema.Never
> = Job.make("ReconcileBucket", {
    payload: bucketPayload,
    success: Schema.Void,
    idempotencyKey: ({ resourceId, requestId }) => `${resourceId}:${requestId}`,
    queue: "buckets",
    defaults: {
        attempts: 3,
        backoff: { type: "exponential", delay: "10 seconds" },
        timeout: "2 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});

const healthCheckPayload = Schema.Struct({});

// Periodic checks (bucket usage, cluster and S3 connection health). Runs from a schedule, never enqueued directly.
export const HealthCheck: Job.Job<
    "HealthCheck",
    typeof healthCheckPayload,
    Schema.Void,
    Schema.Never
> = Job.make("HealthCheck", {
    payload: healthCheckPayload,
    success: Schema.Void,
    queue: "health",
    defaults: {
        // The next tick is the retry.
        attempts: 1,
        timeout: "10 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "7 days" },
        },
    },
});
