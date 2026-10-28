import { startMonitoringWorker } from "@stoat/api/worker";
import { databaseUrl } from "@stoat/config/env";
import { createDb } from "@stoat/db";
import { stopWorker } from "@stoat/workflows/lifecycle";

// Standalone worker for USE_INTERNAL_WORKER=false. Env comes straight from the container.
startMonitoringWorker(createDb({ DATABASE_URL: databaseUrl() }));

// No SvelteKit here to emit sveltekit:shutdown, so drain in-flight jobs on stop signals ourselves.
for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => void stopWorker().finally(() => process.exit(0)));
