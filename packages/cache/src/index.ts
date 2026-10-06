import { createStorage, type StorageValue } from "unstorage";
import lruCacheDriver from "unstorage/drivers/lru-cache";
import redisDriver from "unstorage/drivers/redis";

export type { StorageValue };

// 10 minutes, matching the memory layer below. Redis takes seconds.
const ttlSeconds = 10 * 60;

export type CacheLayer = {
    getItem<T extends StorageValue>(key: string): Promise<T | null>;
    setItem<T extends StorageValue>(key: string, value: T): Promise<void>;
    clear(): Promise<void>;
};

/**
 * Memory-speed reads with a shared Redis/Dragonfly layer for multi-replica coherence.
 * The shared layer is best-effort: any failure degrades to memory-only.
 */
export function createTwoLevel(shared?: CacheLayer): CacheLayer {
    const memory = createStorage({ driver: lruCacheDriver({ max: 1000, ttl: ttlSeconds * 1000 }) });

    async function useShared<T>(op: (layer: CacheLayer) => Promise<T>): Promise<T | null> {
        if (!shared) return null;

        try {
            return await op(shared);
        } catch {
            // The first command can race the handshake while offline queueing is off.
            await new Promise((resolve) => setTimeout(resolve, 300));

            try {
                return await op(shared);
            } catch {
                // A dead shared cache must never break a request.
                return null;
            }
        }
    }

    return {
        async getItem<T extends StorageValue>(key: string): Promise<T | null> {
            const hit = await memory.getItem<T>(key);

            if (hit !== null) return hit;

            const value = await useShared((layer) => layer.getItem<T>(key));

            if (value !== null) await memory.setItem(key, value);

            return value;
        },
        async setItem<T extends StorageValue>(key: string, value: T): Promise<void> {
            await memory.setItem(key, value);
            // Memory stays the source of truth until the shared cache recovers.
            await useShared((layer) => layer.setItem(key, value));
        },
        async clear(): Promise<void> {
            await memory.clear();
            // Memory is cleared either way; the shared layer expires on its own.
            await useShared((layer) => layer.clear());
        },
    };
}

function sharedLayer(): CacheLayer | undefined {
    const url = process.env.REDIS_URL?.trim();

    if (!url) return undefined;

    return redisLayer(url);
}

/** Shared Redis/Dragonfly layer. Dragonfly speaks the Redis protocol, so the Redis driver works. */
export function redisLayer(url: string): CacheLayer {
    return createStorage({
        driver: redisDriver({
            url,
            base: "stoat",
            ttl: ttlSeconds,
            // Fail fast back to memory: never queue behind a dead Dragonfly.
            connectTimeout: 1000,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            retryStrategy: (times) => Math.min(times * 200, 2000),
        }),
    });
}

// ponytail: single Dragonfly instance is the ceiling; add cluster options if it becomes the bottleneck.
export const cache: CacheLayer = createTwoLevel(sharedLayer());

const inflight = new Map<string, Promise<unknown>>();

/**
 * Stale-while-revalidate keyed on an caller-provided window: the previous window is served instantly
 * while one shared fetch refreshes it, so nobody waits on the cluster after the first load.
 */
export async function swr<T>(key: string, window: number, load: () => Promise<T>): Promise<T> {
    const cached = await cache.getItem<{ window: number; value: T }>(key);

    if (cached?.window === window) return cached.value;

    const refresh =
        // SAFETY: keys embed the procedure name, so one key always resolves to one T.
        (inflight.get(key) as Promise<T> | undefined) ??
        load()
            .then(async (value) => {
                await cache.setItem(key, { window, value });

                return value;
            })
            .finally(() => {
                inflight.delete(key);
            });

    inflight.set(key, refresh);

    if (cached) {
        refresh.catch(() => {});

        return cached.value;
    }

    return refresh;
}

export function currentWindow(): number {
    return Math.floor(Date.now() / 15_000);
}

export async function clearCache(): Promise<void> {
    await cache.clear();
    inflight.clear();
}
