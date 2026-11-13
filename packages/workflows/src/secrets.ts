import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

function encryptionKey(secret: string, clusterId: string, label = "clowder") {
    if (secret.length < 32) throw new Error("APP_SECRET must contain at least 32 characters.");

    return Buffer.from(
        hkdfSync("sha256", secret, clusterId, `${label}/monitoring/password/v1`, 32),
    );
}

export function encryptMonitoringPassword(
    password: string,
    secret: string,
    clusterId: string,
    label = "clowder",
) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret, clusterId, label), nonce);
    cipher.setAAD(Buffer.from(clusterId));
    const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);

    return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
    ].join(".");
}

// `label` is the legacy one only when re-encrypting passwords stored before the rename.
export function decryptMonitoringPassword(
    value: string,
    secret: string,
    clusterId: string,
    label = "clowder",
) {
    const [version, nonce, tag, data] = value.split(".");

    if (version !== "v1" || !nonce || !tag || !data)
        throw new Error("Invalid monitoring credential envelope.");

    const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey(secret, clusterId, label),
        Buffer.from(nonce, "base64url"),
    );

    decipher.setAAD(Buffer.from(clusterId));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));

    return Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
    ]).toString("utf8");
}
