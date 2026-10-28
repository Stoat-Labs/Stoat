import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
    decryptColumnValue,
    encryptColumnValue,
    isEncryptedColumnValue,
} from "../../packages/db/src/secret-column";

beforeEach(() => vi.stubEnv("APP_SECRET", "column-test-secret-at-least-32-bytes"));

afterEach(() => vi.unstubAllEnvs());

it("round-trips an encrypted value", () => {
    const stored = encryptColumnValue("sidecar-token", "token-123");

    expect(isEncryptedColumnValue(stored)).toBe(true);
    expect(stored).not.toContain("token-123");
    expect(decryptColumnValue("sidecar-token", stored)).toBe("token-123");
});

it("reads legacy plaintext values as they are", () => {
    expect(decryptColumnValue("sidecar-token", "legacy-token")).toBe("legacy-token");
});

it("refuses a value encrypted for another purpose", () => {
    const stored = encryptColumnValue("other", "token-123");

    expect(() => decryptColumnValue("sidecar-token", stored)).toThrow();
});
