import { createAuth as createConfiguredAuth } from "@stoat/auth";
import { type Database, createDb } from "@stoat/db";
import type { BetterAuthPlugin } from "better-auth";

import { env } from "./env.server";

let db: Database | undefined;

let auth: ReturnType<typeof createConfiguredAuth> | undefined;

let authCookiePlugin: BetterAuthPlugin | undefined;

// Dynamic configuration is only available at runtime, not during build analysis.
export function getDb(): Database {
    return (db ??= createDb(env));
}

/**
 * hooks.server.ts registers SvelteKit's cookie forwarding here, keeping `$app/server` out of
 * this module so tests can import it. Must run before the first getAuth().
 */
export function setAuthCookiePlugin(plugin: BetterAuthPlugin) {
    authCookiePlugin = plugin;
}

export function getAuth() {
    return (auth ??= createConfiguredAuth(env, getDb(), authCookiePlugin));
}
