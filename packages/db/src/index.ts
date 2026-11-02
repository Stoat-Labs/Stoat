import { drizzle } from "drizzle-orm/node-postgres";

import type { DatabaseConfig } from "./config";
import { relations } from "./relations";

export function createDb(env: DatabaseConfig) {
    return drizzle({
        connection: {
            connectionString: env.DATABASE_URL,
            // Opening a connection costs several round trips (TCP, TLS, auth), so keep idle ones
            // for minutes instead of pg's 10s default, which made calls after a pause reconnect.
            idleTimeoutMillis: 5 * 60_000,
            keepAlive: true,
        },
        relations,
    });
}

export type Database = ReturnType<typeof createDb>;
