import type { Context } from "@stoat/api/context";
import type { AppRouterClient } from "@stoat/api/routers/index";
import type { RequestLogger } from "evlog";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
    var $client: AppRouterClient | undefined;

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

export {};
