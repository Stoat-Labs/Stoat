// A pre-release build of the Clowder rename re-encrypted every stored secret under "clowder" key
// labels. These envelopes are built the way that build wrote them, so reads must accept both labels
// while writes keep the legacy "stoat" one.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { decryptColumnValue, encryptColumnValue } from "../../packages/db/src/secret-column";
import {
    decryptGitOAuthClientSecret,
    encryptGitOAuthClientSecret,
} from "../../packages/api/src/git/oauth-secrets";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git/secrets";
import { decryptS3Secret, encryptS3Secret } from "../../packages/s3/src/secrets";
import {
    decryptMonitoringPassword,
    encryptMonitoringPassword,
} from "../../packages/workflows/src/secrets";

const secret = "renamed-labels-test-secret-at-least-32-bytes";

function seal(key: ArrayBuffer, nonce: Buffer, aad: Buffer | null, plaintext: string) {
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);

    if (aad) cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return [nonce, cipher.getAuthTag(), ciphertext];
}

function unseal(key: ArrayBuffer, aad: Buffer | null, parts: Buffer[]) {
    const [nonce, tag, ciphertext] = parts;

    if (!nonce || !tag || !ciphertext) throw new Error("Envelope is missing a part.");

    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), nonce);

    if (aad) decipher.setAAD(aad);

    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function encode(parts: Buffer[]) {
    return parts.map((part) => part.toString("base64url")).join(".");
}

function decode(envelope: string) {
    return envelope.split(".").map((part) => Buffer.from(part, "base64url"));
}

// Flips one ciphertext byte so the auth tag no longer matches. Editing the last base64url character
// is not enough: it can land on padding bits and decode to the same bytes.
function tamper(envelope: string) {
    const split = envelope.lastIndexOf(".");
    const ciphertext = Buffer.from(envelope.slice(split + 1), "base64url");

    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;

    return `${envelope.slice(0, split + 1)}${ciphertext.toString("base64url")}`;
}

beforeEach(() => vi.stubEnv("APP_SECRET", secret));

afterEach(() => vi.unstubAllEnvs());

describe("encrypted columns", () => {
    const columnKey = (label: string, salt: Buffer) =>
        hkdfSync("sha256", secret, salt, `${label}/column/sidecar-token/v1`, 32);

    const renamed = (plaintext: string) => {
        const salt = randomBytes(16);

        return `enc:v1:${encode([salt, ...seal(columnKey("clowder", salt), randomBytes(12), null, plaintext)])}`;
    };

    it("reads values under the renamed label", () => {
        expect(decryptColumnValue("sidecar-token", renamed("token-123"))).toBe("token-123");
    });

    it("still writes under the legacy label", () => {
        const [salt, ...parts] = decode(
            encryptColumnValue("sidecar-token", "token-123").slice("enc:v1:".length),
        );

        if (!salt) throw new Error("Envelope has no salt.");

        expect(unseal(columnKey("stoat", salt), null, parts)).toBe("token-123");
    });

    it("rejects renamed values for another purpose or tampered", () => {
        const stored = renamed("token-123");

        expect(() => decryptColumnValue("cluster-provisioning", stored)).toThrow();
        expect(() => decryptColumnValue("sidecar-token", tamper(stored))).toThrow();
    });
});

describe("monitoring passwords", () => {
    const passwordKey = (label: string, clusterId: string) =>
        hkdfSync("sha256", secret, clusterId, `${label}/monitoring/password/v1`, 32);

    const renamed = (plaintext: string, clusterId: string) =>
        `v1.${encode(seal(passwordKey("clowder", clusterId), randomBytes(12), Buffer.from(clusterId), plaintext))}`;

    it("reads passwords under the renamed label", () => {
        expect(
            decryptMonitoringPassword(renamed("hunter2", "cluster-a"), secret, "cluster-a"),
        ).toBe("hunter2");
    });

    it("still writes under the legacy label", () => {
        const [, ...parts] = decode(encryptMonitoringPassword("hunter2", secret, "cluster-a"));

        expect(unseal(passwordKey("stoat", "cluster-a"), Buffer.from("cluster-a"), parts)).toBe(
            "hunter2",
        );
    });

    it("rejects renamed passwords for another cluster, secret, or tampered", () => {
        const stored = renamed("hunter2", "cluster-a");

        expect(() => decryptMonitoringPassword(stored, secret, "cluster-b")).toThrow();
        expect(() => decryptMonitoringPassword(stored, `${secret}x`, "cluster-a")).toThrow();
        expect(() => decryptMonitoringPassword(tamper(stored), secret, "cluster-a")).toThrow();
    });
});

describe("Git credentials", () => {
    const scope = { organizationId: "org-1", connectionId: "connection-1" };
    const credentials = { username: "git", password: "token" };

    const context = (domain: string, organizationId: string, connectionId: string) =>
        Buffer.from(JSON.stringify([domain, organizationId, connectionId]));

    const renamed = () => {
        const salt = randomBytes(32);
        const aad = context("clowder/git-credentials/v1", scope.organizationId, scope.connectionId);
        const key = hkdfSync("sha256", secret, salt, aad, 32);

        return `v1.${encode([salt, ...seal(key, randomBytes(12), aad, JSON.stringify(credentials))])}`;
    };

    it("reads credentials under the renamed label", () => {
        expect(decryptGitCredentials(renamed(), scope)).toEqual(credentials);
    });

    it("still writes under the legacy label", () => {
        const [, salt, ...parts] = decode(encryptGitCredentials(credentials, scope));

        if (!salt) throw new Error("Envelope has no salt.");

        const aad = context("stoat/git-credentials/v1", scope.organizationId, scope.connectionId);

        expect(JSON.parse(unseal(hkdfSync("sha256", secret, salt, aad, 32), aad, parts))).toEqual(
            credentials,
        );
    });

    it("rejects renamed credentials for another scope or tampered", () => {
        const stored = renamed();

        expect(() => decryptGitCredentials(stored, { ...scope, organizationId: "org-2" })).toThrow(
            "Unable to decrypt Git credentials",
        );
        expect(() =>
            decryptGitCredentials(stored, { ...scope, connectionId: "connection-2" }),
        ).toThrow("Unable to decrypt Git credentials");
        expect(() => decryptGitCredentials(tamper(stored), scope)).toThrow(
            "Unable to decrypt Git credentials",
        );
    });
});

describe("Git OAuth client secrets", () => {
    const scope = {
        organizationId: "org-1",
        id: "provider-1",
        provider: "github",
        serverUrl: "https://github.com",
        clientId: "client-1",
    };

    const context = (domain: string) =>
        Buffer.from(
            JSON.stringify([
                domain,
                scope.organizationId,
                scope.id,
                scope.provider,
                scope.serverUrl,
                scope.clientId,
            ]),
        );

    const renamed = (plaintext: string) => {
        const salt = randomBytes(32);
        const aad = context("clowder/git-oauth-client-secret/v1");
        const key = hkdfSync("sha256", secret, salt, aad, 32);

        return `v1.${encode([salt, ...seal(key, randomBytes(12), aad, plaintext)])}`;
    };

    it("reads client secrets under the renamed label", () => {
        expect(decryptGitOAuthClientSecret(renamed("client-secret"), scope)).toBe("client-secret");
    });

    it("still writes under the legacy label", () => {
        const [, salt, ...parts] = decode(encryptGitOAuthClientSecret("client-secret", scope));

        if (!salt) throw new Error("Envelope has no salt.");

        const aad = context("stoat/git-oauth-client-secret/v1");

        expect(unseal(hkdfSync("sha256", secret, salt, aad, 32), aad, parts)).toBe("client-secret");
    });

    it("rejects renamed client secrets for another destination or tampered", () => {
        const stored = renamed("client-secret");

        expect(() =>
            decryptGitOAuthClientSecret(stored, { ...scope, serverUrl: "https://evil.example" }),
        ).toThrow("Unable to decrypt Git OAuth client secret");
        expect(() => decryptGitOAuthClientSecret(tamper(stored), scope)).toThrow(
            "Unable to decrypt Git OAuth client secret",
        );
    });
});

describe("S3 secrets", () => {
    const scope = {
        kind: "connection-credentials" as const,
        organizationId: "org-1",
        connectionId: "connection-1",
    };

    const context = (label: string) =>
        Buffer.from(`${label}/s3/connection-credentials/v1/org-1/connection-1`);

    const renamed = (plaintext: string) => {
        const salt = randomBytes(32);
        const aad = context("clowder");
        const key = hkdfSync("sha256", secret, salt, aad, 32);

        return `v1.${encode([salt, ...seal(key, randomBytes(12), aad, plaintext)])}`;
    };

    it("reads secrets under the renamed label", () => {
        expect(decryptS3Secret(renamed("access:secret"), scope)).toBe("access:secret");
    });

    it("still writes under the legacy label", () => {
        const [, salt, ...parts] = decode(encryptS3Secret("access:secret", scope));

        if (!salt) throw new Error("Envelope has no salt.");

        const aad = context("stoat");

        expect(unseal(hkdfSync("sha256", secret, salt, aad, 32), aad, parts)).toBe("access:secret");
    });

    it("rejects renamed secrets for another owner or tampered", () => {
        const stored = renamed("access:secret");

        expect(() =>
            decryptS3Secret(stored, { kind: "bucket-credentials", resourceId: "connection-1" }),
        ).toThrow("Unable to decrypt S3 secret");
        expect(() => decryptS3Secret(tamper(stored), scope)).toThrow("Unable to decrypt S3 secret");
    });
});
