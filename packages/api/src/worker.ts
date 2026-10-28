import { startWorker } from "@stoat/workflows/lifecycle";
import { watchGitSources } from "./git-watch";
import { appSecret, databaseUrl } from "@stoat/config/env";
import { encryptLegacySidecarTokens } from "@stoat/db/clusters";
import { monitoringWorkerLive, pollInitializationOutbox } from "@stoat/workflows/runtime";
import { JobStoreLive } from "@stoat/workflows/store";
import { Effect, Layer } from "effect";
import type { Database } from "@stoat/db";

/**
 * Run the background job worker: inside the web server, or as the standalone apps/worker.
 *
 * Call once at process startup (never during `vite build`). The queue itself
 * lives in Postgres via effect-mq, so jobs survive restarts: an
 * in-flight job is reclaimed by the stall sweeper and the outbox sweep
 * re-enqueues anything committed while the queue was unreachable.
 */
export function startMonitoringWorker(db: Database) {
    databaseUrl();
    appSecret();

    encryptLegacySidecarTokens(db).catch((error: Error) =>
        console.error("[worker] Could not encrypt legacy sidecar tokens:", error.message),
    );

    startWorker(
        Layer.launch(monitoringWorkerLive(watchGitSources)),
        pollInitializationOutbox(db).pipe(Effect.provide(JobStoreLive)),
    );
}
