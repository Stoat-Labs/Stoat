import { createDb, type Database } from "@stoat/db";
import {
    appendDeploymentLog,
    getDeploymentByJobId,
    setDeploymentStatus,
} from "@stoat/db/deployments";
import { markBucketFailed, pendingBucketRequests } from "@stoat/db/buckets";
import { setInitializationStatus } from "@stoat/db/initialization";
import { s3FailureMessage } from "@stoat/s3";
import { JobSchedules, JobStore, Worker } from "effect-mq";
import { Cause, Effect, Layer } from "effect";
import { createInitializeClusterHandler } from "./initialize-cluster";
import { CADDY_FAILURE_MESSAGE, deployCaddy } from "./deploy-caddy";
import { deployResource, RESOURCE_FAILURE_MESSAGE } from "./deploy-resource";
import { runHealthCheck } from "./health-check";
import {
    DeployCaddy,
    DeployResource,
    HealthCheck,
    InitializeCluster,
    ReconcileBucket,
    WatchGitSources,
} from "./jobs";
import { reconcileBucket } from "./reconcile-bucket";
import { JobStoreLive, PgLive } from "./store";

function requireEnv(name: string) {
    const value = process.env[name];

    if (!value) throw new Error(`${name} is required for cluster initialization.`);

    return value;
}

// One pool for the whole worker; it ends when the worker layer is released.
const WorkerDb = Effect.acquireRelease(
    Effect.sync(() => createDb({ DATABASE_URL: requireEnv("DATABASE_URL") })),
    (db) => Effect.promise(() => db.$client.end()).pipe(Effect.ignore),
);

function encryptionSecret() {
    return requireEnv("APP_SECRET");
}

const TERMINAL_FAILURE_MESSAGE =
    "Cluster monitoring initialization failed. Check the selected machine and sidecar connectivity, then retry.";

// Plain async attempt. The AbortSignal comes from Effect.callback and aborts on
// interruption, timeout, or cancel so deployMonitoring stops promptly.
async function runAttemptAsync(
    db: Database,
    clusterId: string,
    requestId: string,
    signal: AbortSignal,
) {
    const jobId = `${clusterId}:${requestId}`;

    await setInitializationStatus(db, clusterId, "running", null).catch(() => {});
    const deployment = await getDeploymentByJobId(db, jobId).catch(() => null);

    if (deployment?.status === "cancelled") return;

    if (deployment && deployment.status !== "running") {
        await setDeploymentStatus(db, deployment.id, "running").catch(() => {});
    }

    signal.throwIfAborted();

    const handler = createInitializeClusterHandler(
        db,
        encryptionSecret(),
        deployment ? { deploymentId: deployment.id } : undefined,
    );

    try {
        await handler(clusterId, signal);
    } catch (error) {
        // Handler errors are fixed redacted strings, safe for the log.
        // Skipped on abort: interruption releases the job without an attempt.
        if (!signal.aborted && deployment) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Cluster monitoring initialization failed.";

            await appendDeploymentLog(db, deployment.id, `Step failed: ${message}`, {
                level: "error",
            }).catch(() => {});
        }

        throw error;
    }

    if (deployment) {
        await setDeploymentStatus(db, deployment.id, "ready").catch(() => {});
    }

    await setInitializationStatus(db, clusterId, "ready", null).catch(() => {});
}

function runAttempt(db: Database, clusterId: string, requestId: string) {
    return Effect.callback<void>((resume, signal) => {
        const attempt = runAttemptAsync(db, clusterId, requestId, signal).then(
            () => resume(Effect.void),
            () => resume(Effect.die(new Error(TERMINAL_FAILURE_MESSAGE))),
        );

        // Drain pending writes before the timeout/failure hook publishes terminal status.
        return Effect.promise(() => attempt);
    });
}

// Runs one attempt on the worker's pool. Interruption aborts the signal, then the returned effect
// drains pending writes and releases the lock before effect-mq invokes its terminal failure hook.
function attempt(run: (signal: AbortSignal) => Promise<void>, failure: (error: Error) => Error) {
    return Effect.callback<void>((resume, signal) => {
        const done = run(signal).then(
            () => resume(Effect.void),
            (error) =>
                resume(
                    Effect.die(failure(error instanceof Error ? error : new Error(String(error)))),
                ),
        );

        return Effect.promise(() => done);
    });
}

type GitWatcher = (db: Database, signal: AbortSignal, connectionId?: string) => Promise<void>;

// The Git watcher lives in @stoat/api (it needs Git and deploy logic), which depends on this
// package, so the worker bootstrap passes it in.
function jobHandlersLive(db: Database, watchGitSources: GitWatcher) {
    return Layer.mergeAll(
        InitializeCluster.toLayer(
            (payload) => runAttempt(db, payload.clusterId, payload.requestId),
            {
                concurrency: 1,
            },
        ),
        DeployResource.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) => deployResource(db, deploymentId, signal),
                    // Keep the redacted failure (and its unrecoverable mark), never a raw cause.
                    (error) =>
                        error.message === RESOURCE_FAILURE_MESSAGE
                            ? error
                            : new Error(RESOURCE_FAILURE_MESSAGE),
                ),
            { concurrency: 4 },
        ),
        DeployCaddy.toLayer(
            ({ deploymentId }) =>
                attempt(
                    (signal) => deployCaddy(db, deploymentId, signal),
                    // deployCaddy only throws CADDY_FAILURE_MESSAGE; never pass a raw cause.
                    () => new Error(CADDY_FAILURE_MESSAGE),
                ),
            // One rollout per cluster is enforced when queueing; across clusters they are independent.
            { concurrency: 4 },
        ),
        ReconcileBucket.toLayer(
            ({ resourceId, requestId }) =>
                attempt(
                    (signal) => reconcileBucket(db, resourceId, requestId, signal),
                    (error) => new Error(s3FailureMessage(error)),
                ),
            { concurrency: 2 },
        ),
        HealthCheck.toLayer(
            ({ clusterId }) =>
                attempt(
                    (signal) => runHealthCheck(db, signal, clusterId),
                    (error) => error,
                ),
            { concurrency: 1 },
        ),
        WatchGitSources.toLayer(
            ({ connectionId }) =>
                attempt(
                    (signal) => watchGitSources(db, signal, connectionId),
                    (error) => error,
                ),
            { concurrency: 1 },
        ),
    );
}

// Top of every hour, UTC.
const HEALTH_CHECK_CRON = "0 * * * *";

const GIT_WATCH_CRON = "* * * * *";

// Upserted on startup. Each tick is claimed atomically, so it runs once across web replicas.
export const SchedulesLive = JobSchedules.layer({
    group: "stoat",
    schedules: [
        JobSchedules.schedule(HealthCheck, "hourly", { cron: HEALTH_CHECK_CRON, payload: {} }),
        JobSchedules.schedule(WatchGitSources, "minutely", { cron: GIT_WATCH_CRON, payload: {} }),
    ],
    // Schedules dropped from this list are removed after the grace window.
    removal: "group",
    removeAfter: "10 minutes",
});

async function recordBucketFailureAsync(db: Database, failure: Worker.JobFailure) {
    if (failure.willRetry) return;

    // effect-mq ids are `ReconcileBucket/<resourceId>:<requestId>`.
    const key = failure.jobId.slice(failure.jobId.indexOf("/") + 1);
    const separator = key.indexOf(":");
    const cause = Cause.squash(failure.cause);

    // The handler only dies with messages built by s3FailureMessage; timeouts carry their own.
    await markBucketFailed(
        db,
        key.slice(0, separator),
        new Date(key.slice(separator + 1)),
        cause instanceof Error ? cause.message : "Bucket job failed.",
    );
}

async function recordFailureAsync(db: Database, failure: Worker.JobFailure) {
    // effect-mq namespaces deterministic ids as `<JobName>/<idempotencyKey>`,
    // so strip the prefix before matching our `${clusterId}:${requestId}` shape.
    const rawId = failure.jobId;
    const key = rawId.includes("/") ? rawId.slice(rawId.indexOf("/") + 1) : rawId;
    const sep = key.indexOf(":");
    const clusterId = sep === -1 ? key : key.slice(0, sep);
    const deployment = key ? await getDeploymentByJobId(db, key).catch(() => null) : null;

    // A user-cancelled deployment already carries its final state.
    if (deployment?.status === "cancelled") return;

    if (failure.name === "InitializeCluster" && failure.willRetry) {
        if (!deployment || !["queued", "running"].includes(deployment.status)) return;

        await appendDeploymentLog(
            db,
            deployment.id,
            `Attempt ${failure.attempt} of ${failure.attemptsMax} failed; retrying.`,
            { level: "error", event: "retry" },
        );
        await setDeploymentStatus(db, deployment.id, "queued", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
        await setInitializationStatus(db, clusterId, "retrying", null).catch(() => {});

        return;
    }

    if (failure.name === "DeployResource" || failure.name === "DeployCaddy") {
        if (!deployment || !["queued", "running"].includes(deployment.status)) return;
        const cause = Cause.squash(failure.cause);
        const timedOut = Cause.isTimeoutError(cause);

        const reason = timedOut
            ? cause.message
            : (deployment.error ??
              (failure.name === "DeployCaddy" ? CADDY_FAILURE_MESSAGE : RESOURCE_FAILURE_MESSAGE));

        // The attempt already logged its own reason; only timeouts are new here.
        const text = timedOut ? reason : "Deployment failed.";

        await appendDeploymentLog(db, deployment.id, text, {
            level: "error",
            event: "failed",
        });
        await setDeploymentStatus(db, deployment.id, "failed", reason);

        return;
    }

    if (deployment) {
        await appendDeploymentLog(db, deployment.id, TERMINAL_FAILURE_MESSAGE, {
            level: "error",
            event: "failed",
        });
        await setDeploymentStatus(db, deployment.id, "failed", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
    }

    if (clusterId) {
        await setInitializationStatus(db, clusterId, "failed", TERMINAL_FAILURE_MESSAGE).catch(
            () => {},
        );
    }
}

function workerLive(db: Database) {
    return Worker.layer({
        queues: {
            initialize: { concurrency: 1 },
            deploy: { concurrency: 4 },
            buckets: { concurrency: 2 },
            health: { concurrency: 1 },
            git: { concurrency: 1 },
        },
        lockDuration: "10 minutes",
        // effect-mq also delivers cross-process cancellation on this heartbeat.
        lockRenewInterval: "2 seconds",
        stalledInterval: "1 minute",
        maxStalledCount: 2,
        onJobFailure: (failure) => {
            if (failure.name === "ReconcileBucket")
                return Effect.promise(() => recordBucketFailureAsync(db, failure)).pipe(
                    Effect.ignore,
                );

            if (
                failure.name !== "DeployResource" &&
                failure.name !== "DeployCaddy" &&
                failure.name !== "InitializeCluster"
            )
                return Effect.void;

            return Effect.promise(() => recordFailureAsync(db, failure)).pipe(Effect.ignore);
        },
    });
}

export function monitoringWorkerLive(watchGitSources: GitWatcher) {
    return Layer.unwrap(
        Effect.map(WorkerDb, (db) =>
            Layer.mergeAll(jobHandlersLive(db, watchGitSources), SchedulesLive).pipe(
                Layer.provideMerge(workerLive(db)),
                Layer.provideMerge(JobStoreLive),
            ),
        ),
    );
}

// Enqueue (or re-enqueue) initialization for a cluster. Idempotent per
// (clusterId, requestId) via the job's idempotencyKey.
export function enqueueInitialization(clusterId: string, requestId: string) {
    return InitializeCluster.enqueue({ clusterId, requestId });
}

export async function queueResourceDeployment(deploymentId: string): Promise<void> {
    await Effect.runPromise(
        DeployResource.enqueue({ deploymentId }).pipe(Effect.provide(JobStoreLive)),
    );
}

// A push webhook fired: check that connection's resources now instead of on the next tick.
export async function queueGitWatch(connectionId: string): Promise<void> {
    await Effect.runPromise(
        WatchGitSources.enqueue({ connectionId }).pipe(Effect.provide(JobStoreLive)),
    );
}

// The bucket row is the durable outbox if enqueue is temporarily unavailable.
export async function queueBucketReconcile(resourceId: string, requestedAt: Date): Promise<void> {
    await Effect.runPromise(
        ReconcileBucket.enqueue({ resourceId, requestId: requestedAt.toISOString() }).pipe(
            Effect.provide(JobStoreLive),
        ),
    );
}

// At most one manual run per cluster a minute, however often the button is pressed.
export async function queueClusterHealthCheck(clusterId: string): Promise<void> {
    await Effect.runPromise(
        HealthCheck.enqueue(
            { clusterId },
            { dedupe: { key: `cluster:${clusterId}`, ttl: "1 minute" } },
        ).pipe(Effect.provide(JobStoreLive)),
    );
}

/**
 * Best-effort cancel of a queued or running deployment job.
 * effect-mq namespaces the stored jobId internally, which is added here. Never throws:
 * a missing or already-settled job simply means there is nothing to stop.
 */
export async function cancelDeploymentJob(
    jobId: string,
    name: "InitializeCluster" | "DeployResource" | "DeployCaddy" = "InitializeCluster",
): Promise<void> {
    try {
        const job =
            name === "DeployResource"
                ? DeployResource
                : name === "DeployCaddy"
                  ? DeployCaddy
                  : InitializeCluster;

        const program = job
            .cancel(JobStore.JobId(`${name}/${jobId}`))
            .pipe(Effect.provide(JobStoreLive));

        await Effect.runPromise(program);
    } catch {
        /* ignore: already settled or never enqueued */
    }
}

async function pollOutboxAsync(db: Database) {
    const initialization = await db.$client.query<{ clusterId: string; requestedAt: Date }>(
        `SELECT id AS "clusterId", initialization_requested_at AS "requestedAt" FROM clusters
         WHERE initialization_status = 'queued' AND initialization_requested_at IS NOT NULL
         AND initialised_at IS NULL`,
    );

    const queued = await db.$client.query<{ deploymentId: string; name: string }>(
        `SELECT id AS "deploymentId", name FROM deployments
         WHERE status = 'queued' AND name IN ('DeployResource', 'DeployCaddy')`,
    );

    const buckets = await pendingBucketRequests(db);

    return {
        initialization: initialization.rows,
        resources: queued.rows.filter((row) => row.name === "DeployResource"),
        caddy: queued.rows.filter((row) => row.name === "DeployCaddy"),
        buckets,
    };
}

// Sweep durable request rows, never deployment logs. Every job type is idempotent.
export function pollInitializationOutbox(db: Database) {
    return Effect.promise(() => pollOutboxAsync(db)).pipe(
        Effect.flatMap(({ initialization, resources, caddy, buckets }) =>
            Effect.forEach(
                [
                    ...initialization.map((row) =>
                        enqueueInitialization(row.clusterId, row.requestedAt.toISOString()),
                    ),
                    ...resources.map(({ deploymentId }) =>
                        DeployResource.enqueue({ deploymentId }),
                    ),
                    ...caddy.map(({ deploymentId }) => DeployCaddy.enqueue({ deploymentId })),
                    ...buckets.map((row) =>
                        ReconcileBucket.enqueue({
                            resourceId: row.resourceId,
                            requestId: row.requestedAt.toISOString(),
                        }),
                    ),
                ],
                (enqueue) => enqueue.pipe(Effect.catch(() => Effect.void)),
            ),
        ),
        Effect.catch(() => Effect.void),
    );
}

export { JobStoreLive, PgLive };

export { DeployCaddy, DeployResource, HealthCheck, InitializeCluster, ReconcileBucket };

export type { Database };
