import type { Context } from "@stoat/api/context";
import type { AppRouterClient } from "@stoat/api/routers/index";
import type { NodeAdapter } from "crossws/adapters/node";
import type { RequestLogger } from "evlog";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
    /** Injected by vite.config.ts at build time. */
    const __APP_VERSION__: string;
    const __GIT_COMMIT__: string | null;

    var $client: AppRouterClient | undefined;

    /** The /rpc WebSocket server for oRPC. Set by $lib/server/rpc-socket.ts. */
    var $rpcSockets: NodeAdapter | undefined;

    namespace App {
        // interface Error {}
        interface Locals {
            log: RequestLogger;
            /** Resolved once per request in hooks.server.ts. */
            session: Context["session"];
        }
        // interface PageData {}
        // interface PageState {}
        // interface Platform {}
    }
}

declare module "svelte/elements" {
    interface HTMLAttributes<T> {
        /** Tells skullet to draw nothing for this element while loading. */
        "skullet-ignore"?: boolean;
    }
}

export {};
