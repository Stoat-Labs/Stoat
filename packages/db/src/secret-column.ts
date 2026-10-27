import { appSecret } from "@stoat/config/env";
import { customType } from "drizzle-orm/pg-core";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function key(purpose: string, salt: Buffer) {
    return Buffer.from(hkdfSync("sha256", appSecret(), salt, `stoat/column/${purpose}/v1`, 32));
}

export function encryptColumnValue(purpose: string, plaintext: string) {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(purpose, salt), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return `${PREFIX}${[salt, nonce, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".")}`;
}

export function decryptColumnValue(purpose: string, stored: string) {
    // Rows written before encryption hold the plaintext and keep working until rewritten.
    if (!stored.startsWith(PREFIX)) return stored;

    const [salt, nonce, tag, ciphertext] = stored
        .slice(PREFIX.length)
        .split(".")
        .map((part) => Buffer.from(part, "base64url"));

    if (!salt || !nonce || !tag || !ciphertext)
        throw new Error(`Stored ${purpose} is not a valid encrypted value.`);

    const decipher = createDecipheriv("aes-256-gcm", key(purpose, salt), nonce);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isEncryptedColumnValue(stored: string) {
    return stored.startsWith(PREFIX);
}

/**
 * A text column encrypted with APP_SECRET. Reads and writes stay plain strings in code. Without
 * APP_SECRET (tests that never set it) values are stored as they are, like legacy rows.
 */
export function encryptedText(name: string, purpose: string) {
    return customType<{ data: string; driverData: string }>({
        dataType: () => "text",
        toDriver: (value) => (process.env.APP_SECRET ? encryptColumnValue(purpose, value) : value),
        fromDriver: (value) => decryptColumnValue(purpose, value),
    })(name);
}
