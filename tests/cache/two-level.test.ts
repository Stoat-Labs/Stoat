import { expect, it, vi } from "vite-plus/test";
import { createTwoLevel, type CacheLayer, type StorageValue } from "../../packages/cache/src/index";

function mapLayer() {
    const store = new Map<string, StorageValue>();

    const layer: CacheLayer = {
        async getItem<T extends StorageValue>(key: string): Promise<T | null> {
            // SAFETY: this stub only returns values stored through setItem in the same test.
            return (store.get(key) ?? null) as T | null;
        },
        async setItem<T extends StorageValue>(key: string, value: T): Promise<void> {
            store.set(key, value);
        },
        async clear(): Promise<void> {
            store.clear();
        },
    };

    return { layer, store };
}

function deadLayer(): CacheLayer {
    const fail = async (): Promise<never> => {
        throw new Error("shared cache is down");
    };

    return { getItem: fail, setItem: fail, clear: fail };
}

it("writes through to both layers and then reads from memory", async () => {
    const { layer: shared } = mapLayer();
    const cache = createTwoLevel(shared);
    await cache.setItem("key", { value: 1 });
    await expect(shared.getItem("key")).resolves.toEqual({ value: 1 });

    const get = vi.spyOn(shared, "getItem");
    await expect(cache.getItem("key")).resolves.toEqual({ value: 1 });
    expect(get).not.toHaveBeenCalled();
});

it("falls through to the shared layer on a memory miss and backfills", async () => {
    const { layer: shared } = mapLayer();
    await shared.setItem("key", { value: 2 });

    // A second replica starts with an empty memory layer over the same shared data.
    const replica = createTwoLevel(shared);
    const get = vi.spyOn(shared, "getItem");

    await expect(replica.getItem("key")).resolves.toEqual({ value: 2 });
    expect(get).toHaveBeenCalledTimes(1);
    await expect(replica.getItem("key")).resolves.toEqual({ value: 2 });
    expect(get).toHaveBeenCalledTimes(1);
});

it("degrades to memory-only when the shared layer fails", async () => {
    const cache = createTwoLevel(deadLayer());

    await cache.setItem("key", { value: 3 });
    await expect(cache.getItem("key")).resolves.toEqual({ value: 3 });
    await expect(cache.getItem("missing")).resolves.toBeNull();
    await cache.clear();
    await expect(cache.getItem("key")).resolves.toBeNull();
});
