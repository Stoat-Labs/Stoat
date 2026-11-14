import { appSecret } from "@clowder/config/env";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Every secret is bound to where it is stored, so a ciphertext copied to another row fails to open.
export type S3SecretScope =
    | { kind: "connection-credentials"; organizationId: string; connectionId: string }
    | { kind: "connection-api-token"; organizationId: string; connectionId: string }
    | { kind: "bucket-credentials"; resourceId: string };

// A pre-release build of the Clowder rename re-encrypted secrets under "clowder"; reads accept both.
function context(scope: S3SecretScope, label: string) {
    const owner =
        scope.kind === "bucket-credentials"
            ? scope.resourceId
            : `${scope.organizationId}/${scope.connectionId}`;

    return Buffer.from(`${label}/s3/${scope.kind}/v1/${owner}`);
}

function key(scope: S3SecretScope, salt: Buffer, label = "stoat") {
    return {
        key: hkdfSync("sha256", appSecret(), salt, context(scope, label), 32),
        context: context(scope, label),
    };
}

export function encryptS3Secret(plaintext: string, scope: S3SecretScope) {
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const material = key(scope, salt);
    const cipher = createCipheriv("aes-256-gcm", material.key, nonce);
    cipher.setAAD(material.context);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return `v1.${[salt, nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".")}`;
}

export function decryptS3Secret(envelope: string, scope: S3SecretScope) {
    try {
        const [version, ...parts] = envelope.split(".");
        const [salt, nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));

        if (
            version !== "v1" ||
            parts.length !== 4 ||
            salt?.length !== 32 ||
            nonce?.length !== 12 ||
            tag?.length !== 16 ||
            !ciphertext
        )
            throw new Error();

        const open = (label: string) => {
            const material = key(scope, salt, label);
            const decipher = createDecipheriv("aes-256-gcm", material.key, nonce);
            decipher.setAAD(material.context);
            decipher.setAuthTag(tag);

            return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        };

        try {
            return open("stoat");
        } catch {
            return open("clowder");
        }
    } catch {
        throw new Error("Unable to decrypt S3 secret");
    }
}
