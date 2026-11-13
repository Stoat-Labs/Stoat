import { appSecret } from "@clowder/config/env";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as v from "valibot";

import type { GitCredentials } from "./index";

type Scope = { organizationId: string; connectionId: string };

const credentialField = v.optional(
    v.pipe(
        v.string(),
        v.check((value) => Buffer.byteLength(value) <= 128 * 1024),
    ),
);

const credentialsSchema = v.strictObject({
    username: credentialField,
    password: credentialField,
    privateKey: credentialField,
    knownHosts: credentialField,
    oauthProviderId: credentialField,
    refreshToken: credentialField,
    expiresAt: credentialField,
});

const scopeSchema = v.object({
    organizationId: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
    connectionId: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
});

function keyMaterial(scope: Scope, salt: Buffer, label = "clowder") {
    const secret = appSecret();

    if (!v.is(scopeSchema, scope)) {
        throw new Error("Invalid Git credential scope");
    }

    const context = Buffer.from(
        JSON.stringify([`${label}/git-credentials/v1`, scope.organizationId, scope.connectionId]),
    );

    return { context, key: hkdfSync("sha256", secret, salt, context, 32) };
}

export function encryptGitCredentials(
    credentials: GitCredentials,
    scope: Scope,
    label = "clowder",
): string {
    const parsed = v.safeParse(credentialsSchema, credentials);

    if (!parsed.success) throw new Error("Invalid Git credentials");
    const plaintext = Buffer.from(JSON.stringify(parsed.output));

    if (plaintext.length > 512 * 1024) throw new Error("Git credentials exceed storage limits");
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const { key, context } = keyMaterial(scope, salt, label);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return `v1.${[salt, nonce, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".")}`;
}

// `label` is the legacy one only when re-encrypting credentials stored before the rename.
export function decryptGitCredentials(
    envelope: string,
    scope: Scope,
    label = "clowder",
): GitCredentials {
    try {
        if (!v.is(v.pipe(v.string(), v.maxLength(1024 * 1024)), envelope)) throw new Error();
        const parts = envelope.split(".");

        if (parts.length !== 5 || parts[0] !== "v1") throw new Error();

        const decoded = parts.slice(1).map((part) => {
            const bytes = Buffer.from(part, "base64url");

            if (!part || bytes.toString("base64url") !== part) throw new Error();

            return bytes;
        });

        const [salt, nonce, tag, ciphertext] = decoded;

        if (
            !salt ||
            salt.length !== 32 ||
            !nonce ||
            nonce.length !== 12 ||
            !tag ||
            tag.length !== 16 ||
            !ciphertext
        ) {
            throw new Error();
        }

        const { key, context } = keyMaterial(scope, salt, label);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(context);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        return v.parse(credentialsSchema, JSON.parse(plaintext.toString("utf8")));
    } catch {
        // Never attach crypto errors or the encrypted payload as an error cause.
        throw new Error("Unable to decrypt Git credentials");
    }
}
