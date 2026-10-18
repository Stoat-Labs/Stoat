import type { Plugin } from "vite";

/** Hands /rpc WebSocket upgrades on the dev server to oRPC, leaving Vite's HMR socket alone. */
export function rpcSocket(): Plugin {
    return {
        name: "stoat-rpc-socket",
        configureServer(server) {
            server.httpServer?.on("upgrade", (request, socket, head) => {
                if (new URL(request.url ?? "/", "http://localhost").pathname !== "/rpc") return;

                // hooks.server.ts sets the handler once the first page has rendered; until
                // then the client just reconnects.
                if (globalThis.$rpcSockets)
                    void globalThis.$rpcSockets.handleUpgrade(request, socket, head);
                else socket.destroy();
            });
        },
    };
}
