import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { createTwoLevel, redisLayer } from "../../packages/cache/src/index";

const url = process.env.REDIS_URL;

it.runIf(url)("shares values between replicas through dragonfly", async () => {
    const shared = redisLayer(url!);
    const first = createTwoLevel(shared);
    const key = `test:${randomUUID()}`;

    await first.setItem(key, { value: 7 });

    // A second replica with an empty memory layer reads through the shared one.
    const second = createTwoLevel(shared);
    await expect(second.getItem(key)).resolves.toEqual({ value: 7 });

    await shared.clear();
});
