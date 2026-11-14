import { appSecret } from "@clowder/config/env";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import * as v from "valibot";

type Scope = {
    organizationId: string;
    id: string;
    provider: string;
    serverUrl: string;
    clientId: string;
};

const domain = "stoat/git-oauth-client-secret/v1";

// A pre-release build of the Clowder rename re-encrypted secrets under this; reads accept both.
const renamedDomain = "clowder/git-oauth-client-secret/v1";

function keyMaterial(scope: Scope, salt: Buffer, label = domain) {
    const secret = appSecret();

    const values = [
        scope.organizationId,
        scope.id,
        scope.provider,
        scope.serverUrl,
        scope.clientId,
    ];

    if (!v.is(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))), values))
        throw new Error();
    // Bind the secret to the organization, app, and destination, not just its row ID.
    const context = Buffer.from(JSON.stringify([label, ...values]));

    return { context, key: hkdfSync("sha256", secret, salt, context, 32) };
}

export function encryptGitOAuthClientSecret(secret: string, scope: Scope): string {
    try {
        if (!v.is(v.pipe(v.string(), v.minLength(1), v.maxLength(8192)), secret)) throw new Error();
        const salt = randomBytes(32);
        const nonce = randomBytes(12);
        const { key, context } = keyMaterial(scope, salt);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(context);
        const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

        return `v1.${[salt, nonce, cipher.getAuthTag(), ciphertext]
            .map((part) => part.toString("base64url"))
            .join(".")}`;
    } catch {
        throw new Error("Unable to encrypt Git OAuth client secret");
    }
}

export function decryptGitOAuthClientSecret(envelope: string, scope: Scope): string {
    try {
        if (!v.is(v.pipe(v.string(), v.maxLength(64 * 1024)), envelope)) throw new Error();
        const parts = envelope.split(".");

        if (parts.length !== 5 || parts[0] !== "v1") throw new Error();

        const [salt, nonce, tag, ciphertext] = parts.slice(1).map((part) => {
            const bytes = Buffer.from(part, "base64url");

            if (!part || bytes.toString("base64url") !== part) throw new Error();

            return bytes;
        });

        if (salt?.length !== 32 || nonce?.length !== 12 || tag?.length !== 16 || !ciphertext)
            throw new Error();

        const open = (label: string) => {
            const { key, context } = keyMaterial(scope, salt, label);
            const decipher = createDecipheriv("aes-256-gcm", key, nonce);
            decipher.setAAD(context);
            decipher.setAuthTag(tag);

            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        };

        let secret: string;

        try {
            secret = open(domain);
        } catch {
            secret = open(renamedDomain);
        }

        if (!secret || secret.length > 8192) throw new Error();

        return secret;
    } catch {
        throw new Error("Unable to decrypt Git OAuth client secret");
    }
}
