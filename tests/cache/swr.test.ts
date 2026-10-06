import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { clearCache, currentWindow, swr } from "../../packages/cache/src/index";

it("serves the cached value within a window and dedupes inflight loads", async () => {
    await clearCache();
    const key = `test:${randomUUID()}`;
    const load = vi.fn(async () => ({ at: Date.now() }));
    const window = currentWindow();

    const [first, second] = await Promise.all([swr(key, window, load), swr(key, window, load)]);

    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(swr(key, window, load)).resolves.toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
});

it("serves stale while revalidating into the next window", async () => {
    await clearCache();
    const key = `test:${randomUUID()}`;
    let version = 0;

    const load = async () => {
        version += 1;

        return { version };
    };

    const window = currentWindow();

    const first = await swr(key, window, load);
    expect(first).toEqual({ version: 1 });

    const stale = await swr(key, window + 1, load);
    expect(stale).toEqual(first);

    await vi.waitFor(async () => expect((await swr(key, window + 1, load)).version).toBe(2));
});
