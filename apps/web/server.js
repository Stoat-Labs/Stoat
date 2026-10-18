import { server } from "./build/index.js";

// adapter-node has no WebSocket support, so /rpc upgrades go to oRPC (src/lib/server/rpc-socket.ts).
// Importing the build runs SvelteKit's init, which loads hooks.server.ts and sets $rpcSockets.
server.server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (path === "/rpc" && globalThis.$rpcSockets)
        void globalThis.$rpcSockets.handleUpgrade(request, socket, head);
    else socket.destroy();
});

// adapter-node's graceful shutdown waits for every connection but never closes upgraded ones.
// Drop them so it can finish; clients reconnect to the next instance.
for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => globalThis.$rpcSockets?.closeAll(undefined, undefined, true));
