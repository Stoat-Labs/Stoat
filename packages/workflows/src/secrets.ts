import {
    createCipheriv,
    createDecipheriv,
    generateKeyPairSync,
    hkdfSync,
    randomBytes,
} from "node:crypto";

const MONITORING_PASSWORD = "stoat/monitoring/password/v1";

const PROVISION_KEY = "stoat/provision/ssh-key/v1";

function encryptionKey(secret: string, scope: string, purpose: string) {
    if (secret.length < 32) throw new Error("APP_SECRET must contain at least 32 characters.");

    return Buffer.from(hkdfSync("sha256", secret, scope, purpose, 32));
}

function encrypt(value: string, secret: string, scope: string, purpose: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret, scope, purpose), nonce);
    cipher.setAAD(Buffer.from(scope));
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

    return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
    ].join(".");
}

function decrypt(value: string, secret: string, scope: string, purpose: string) {
    const [version, nonce, tag, data] = value.split(".");

    if (version !== "v1" || !nonce || !tag || !data)
        throw new Error("Invalid credential envelope.");

    const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey(secret, scope, purpose),
        Buffer.from(nonce, "base64url"),
    );

    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));

    return Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
    ]).toString("utf8");
}

export function encryptMonitoringPassword(password: string, secret: string, clusterId: string) {
    return encrypt(password, secret, clusterId, MONITORING_PASSWORD);
}

export function decryptMonitoringPassword(value: string, secret: string, clusterId: string) {
    return decrypt(value, secret, clusterId, MONITORING_PASSWORD);
}

export function decryptProvisionKey(value: string, secret: string, provisionId: string) {
    return decrypt(value, secret, provisionId, PROVISION_KEY);
}

// SSH wire encoding: a uint32 length, then the bytes.
function sshString(value: Buffer) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);

    return Buffer.concat([length, value]);
}

/** A fresh ed25519 key for one provisioning: the OpenSSH public key and the encrypted private key. */
export function generateProvisionKey(secret: string, provisionId: string, comment: string) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    // An ed25519 SPKI document ends with the raw 32-byte public key.
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);
    // Uncloud's Go SSH client reads PKCS#8 PEM keys.
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    return {
        publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
        encryptedPrivateKey: encrypt(pem, secret, provisionId, PROVISION_KEY),
    };
}
