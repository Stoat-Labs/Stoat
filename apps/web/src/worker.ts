import { stopWorker } from "@stoat/workflows/lifecycle";
import { startMonitoringWorker } from "./lib/server/worker";

// Standalone worker for USE_INTERNAL_WORKER=false. Built by vite.worker.config.ts into worker.js.
startMonitoringWorker();

// No SvelteKit here to emit sveltekit:shutdown, so drain in-flight jobs on stop signals ourselves.
for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => void stopWorker().finally(() => process.exit(0)));
