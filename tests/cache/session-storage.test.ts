import { expect, it } from "vite-plus/test";
import { createSessionStorage } from "../../packages/auth/src/session-storage";

// Nothing listens on port 1, so every command fails like a Dragonfly outage.
const storage = createSessionStorage("redis://127.0.0.1:1");

it("falls back to Postgres when Dragonfly is down", async () => {
    await expect(storage.get("session-token")).resolves.toBeNull();
    await expect(storage.set("session-token", "{}", 60)).resolves.toBeUndefined();
});

it("lets sign-ins through instead of rate limiting during an outage", async () => {
    await expect(storage.increment("rate-limit", 60)).resolves.toBe(1);
});

it("surfaces failed deletes so a revocation cannot silently leave the session cached", async () => {
    await expect(storage.delete("session-token")).rejects.toThrow();
});
