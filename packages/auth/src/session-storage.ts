import type { SecondaryStorage } from "better-auth";
import { Redis } from "ioredis";

/**
 * Better Auth secondary storage on Dragonfly/Redis. Sessions are also kept in Postgres, so a
 * failed read falls back to the database copy instead of failing the request. Deletes still
 * throw, so session revocations report the failure instead of leaving the session alive in the
 * cache. (Better Auth's own sign-out logs that error and clears the browser cookie regardless.)
 */
export function createSessionStorage(url: string): SecondaryStorage {
    const redis = new Redis(url, {
        // Distinct from @stoat/cache's `stoat:` keys, which that package may clear.
        keyPrefix: "stoat-auth:",
        // Fail fast to Postgres: never queue behind a dead Dragonfly.
        connectTimeout: 1000,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 200, 2000),
    });

    // ioredis emits connection errors as events; unhandled ones would crash the process.
    redis.on("error", () => {});

    return {
        async get(key) {
            try {
                return await redis.get(key);
            } catch {
                return null;
            }
        },
        async getAndDelete(key) {
            return redis.getdel(key);
        },
        async increment(key, ttl) {
            try {
                // Open the window with its expiry first, so a failure between the two commands
                // can never leave a counter that lives forever.
                await redis.set(key, 0, "EX", ttl, "NX");

                return await redis.incr(key);
            } catch {
                // Rate limits fail open: a Dragonfly outage must not block every sign-in.
                return 1;
            }
        },
        async set(key, value, ttl) {
            try {
                if (ttl) await redis.set(key, value, "EX", ttl);
                else await redis.set(key, value);
            } catch {
                // A stale entry would outlive this failure for the whole session lifetime, so
                // drop it and let reads fall back to Postgres.
                await redis.del(key).catch(() => {});
            }
        },
        async delete(key) {
            await redis.del(key);
        },
    };
}
