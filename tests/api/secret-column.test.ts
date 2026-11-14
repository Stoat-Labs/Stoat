import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
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

it("reads values a pre-release build of the rename encrypted under the clowder label", () => {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);

    const key = hkdfSync(
        "sha256",
        "column-test-secret-at-least-32-bytes",
        salt,
        "clowder/column/sidecar-token/v1",
        32,
    );

    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
    const ciphertext = Buffer.concat([cipher.update("token-123", "utf8"), cipher.final()]);

    const stored = `enc:v1:${[salt, nonce, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".")}`;

    expect(decryptColumnValue("sidecar-token", stored)).toBe("token-123");
});

it("refuses a value encrypted for another purpose", () => {
    const stored = encryptColumnValue("other", "token-123");

    expect(() => decryptColumnValue("sidecar-token", stored)).toThrow();
});
