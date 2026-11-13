import { stopWorker } from "@clowder/workflows/lifecycle";
import type { Plugin } from "vite";

export function monitoringWorker(): Plugin {
    return {
        name: "clowder-monitoring-worker",
        async configureServer(server) {
            // A restart configures its new server before tearing down the old one, without calling close().
            await stopWorker();

            const close = server.close.bind(server);

            // closeBundle and closeServer run after the module runner is torn down, which is too late.
            server.close = async () => {
                await stopWorker();
                await close();
            };
        },
    };
}
