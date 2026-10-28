import { startWorker } from "@stoat/workflows/lifecycle";
import { watchGitSources } from "@stoat/api/git-watch";
import { appSecret, databaseUrl } from "@stoat/config/env";
import { encryptLegacySidecarTokens } from "@stoat/db/clusters";
import {
    monitoringWorkerLive,
    pollInitializationOutbox,
    rollOutMonitoring,
} from "@stoat/workflows/runtime";
import { JobStoreLive } from "@stoat/workflows/store";
import { Effect, Layer } from "effect";
import { getDb } from "../../services";

/**
 * Run the cluster-monitoring worker inside the web server process.
 *
 * Call once at server startup (never during `vite build`). The queue itself
 * lives in Postgres via effect-mq, so jobs survive web restarts: an
 * in-flight job is reclaimed by the stall sweeper and the outbox sweep
 * re-enqueues anything committed while the queue was unreachable.
 *
 * NOTE: this requires a long-lived Node server (adapter-node). Moving to a
 * serverless adapter means moving this back out into a dedicated process.
 */
export function startMonitoringWorker() {
    databaseUrl();
    appSecret();

    encryptLegacySidecarTokens(getDb()).catch((error: Error) =>
        console.error("[worker] Could not encrypt legacy sidecar tokens:", error.message),
    );

    const started = startWorker(
        Layer.launch(monitoringWorkerLive(watchGitSources)),
        pollInitializationOutbox(getDb()).pipe(Effect.provide(JobStoreLive)),
    );

    // Once per process start (not per dev reload), never in the sweep: workers still on the old
    // version mid-roll must not push their template back.
    if (started)
        Effect.runPromise(rollOutMonitoring(getDb()).pipe(Effect.provide(JobStoreLive))).catch(
            (error: Error) =>
                console.error("[worker] Could not queue monitoring rollouts:", error.message),
        );
}
