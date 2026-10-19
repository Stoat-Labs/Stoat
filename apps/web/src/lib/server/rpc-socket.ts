import { onError } from "@orpc/server";
import { experimental_RPCHandler as RPCHandler } from "@orpc/server/crossws";
import type { Context } from "@stoat/api/context";
import { appRouter } from "@stoat/api/routers/index";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/node";
import { createRequestLogger } from "evlog";

import { getAuth, getDb } from "../../services";
import { logRpcError } from "./rpc-errors";

const handler = new RPCHandler(appRouter, {
    interceptors: [
        onError((error) => {
            // A socket message has no request lifecycle, so each failed call emits its own event.
            const log = createRequestLogger({ method: "WS", path: "/rpc" });

            logRpcError(log, error instanceof Error ? error : new Error(String(error)));
            log.emit();
        }),
    ],
});

const sessionReads = new WeakMap<Peer, Promise<Context["session"]>>();

/**
 * Read per call, so sign-outs and organization switches apply immediately. Calls a page sends
 * together share the read already in flight instead of each waiting on its own.
 */
function readSession(peer: Peer) {
    let read = sessionReads.get(peer);

    if (!read) {
        read = getAuth()
            .api.getSession({ headers: peer.request.headers })
            .finally(() => sessionReads.delete(peer));
        sessionReads.set(peer, read);
    }

    return read;
}

const sockets = crossws({
    // Replaces the response compression the HTTP RPC handler had. Small frames are not worth it.
    serverOptions: { perMessageDeflate: { threshold: 1024 } },
    hooks: {
        upgrade(request) {
            // Browsers send cookies on cross-site WebSocket handshakes and CORS does not apply,
            // so only accept sockets opened by pages served from this host.
            const origin = request.headers.get("origin");

            if (!origin || new URL(origin).host !== request.headers.get("host"))
                throw new Response("Forbidden", { status: 403 });
        },
        message(peer, message) {
            void handler.message(peer, message, {
                context: async () => ({ db: getDb(), session: await readSession(peer) }),
            });
        },
        close(peer) {
            // Aborts the streams this socket still had open.
            void handler.close(peer);
        },
        error(peer) {
            void handler.close(peer);
        },
    },
});

// Read by server.js in production and rpc-socket-plugin.ts in dev, which both live outside the
// SvelteKit bundle and so cannot import this module directly. When dev HMR re-runs this module,
// close the previous instance's sockets so open tabs reconnect to the current router.
globalThis.$rpcSockets?.closeAll(1012, "Server restarting");

globalThis.$rpcSockets = sockets;
