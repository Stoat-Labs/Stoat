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

const rolloutPayload = Schema.Struct({
    clusterId: Schema.String,
    // MONITORING_VERSION of the worker that queued it.
    version: Schema.Number,
});

// Its own queue, so workers from before versioned rollouts never claim one.
export const RollOutMonitoring: Job.Job<
    "RollOutMonitoring",
    typeof rolloutPayload,
    Schema.Void,
    Schema.Never
> = Job.make("RollOutMonitoring", {
    payload: rolloutPayload,
    success: Schema.Void,
    idempotencyKey: ({ clusterId, version }) => `${clusterId}:v${version}`,
    queue: "monitoring",
    defaults: {
        attempts: 5,
        backoff: { type: "exponential", delay: "30 seconds" },
        timeout: "15 minutes",
        keep: {
            // The version is stored before completing, so a finished job is never needed again; a
            // short window lets the sweep re-queue a cluster an older worker re-initialized.
            completed: { age: "1 minute" },
            // Short, so the outbox sweep re-queues a cluster that was unreachable.
            failed: { age: "1 hour" },
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
        // No retries: a failed deployment stays failed until the user redeploys.
        attempts: 1,
        timeout: "15 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});

// Rolls out the cluster's caddy service with the image and global Caddyfile in the deployment spec.
export const DeployCaddy: Job.Job<
    "DeployCaddy",
    typeof resourcePayload,
    Schema.Void,
    Schema.Never
> = Job.make("DeployCaddy", {
    payload: resourcePayload,
    success: Schema.Void,
    idempotencyKey: ({ deploymentId }) => deploymentId,
    queue: "deploy",
    defaults: {
        // No retries: a half-rolled ingress update is safer to redeploy on purpose.
        attempts: 1,
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

// The hourly schedule checks everything; a manual run from the cluster page passes its cluster.
const healthCheckPayload = Schema.Struct({ clusterId: Schema.optional(Schema.String) });

// Periodic checks (bucket usage, cluster and S3 connection health). Runs hourly from a schedule,
// or on demand for one cluster through `queueClusterHealthCheck`.
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

// Without a connection, every Git connection is checked.
const watchPayload = Schema.Struct({ connectionId: Schema.optional(Schema.String) });

// Polls Git-bound resources with auto-deploy on and deploys pushes to their watched directory.
// Runs every minute from a schedule, and for one connection when its push webhook fires.
export const WatchGitSources: Job.Job<
    "WatchGitSources",
    typeof watchPayload,
    Schema.Void,
    Schema.Never
> = Job.make("WatchGitSources", {
    payload: watchPayload,
    success: Schema.Void,
    queue: "git",
    defaults: {
        // The next tick is the retry.
        attempts: 1,
        timeout: "5 minutes",
        keep: {
            completed: { age: "1 hour" },
            failed: { age: "7 days" },
        },
    },
});

export const ProvisionCluster: Job.Job<
    "ProvisionCluster",
    typeof resourcePayload,
    Schema.Void,
    Schema.Never
> = Job.make("ProvisionCluster", {
    // Each attempt is its own `ProvisionCluster` deployment of the cluster being set up.
    payload: resourcePayload,
    success: Schema.Void,
    idempotencyKey: ({ deploymentId }) => deploymentId,
    queue: "provision",
    defaults: {
        // No retries: SSH and server problems need the user, and a retry may need a reset.
        attempts: 1,
        // Installing Docker and issuing the sidecar's certificate can take several minutes.
        timeout: "20 minutes",
        keep: {
            completed: { age: "1 day" },
            failed: { age: "30 days" },
        },
    },
});
