import { SignatureV4 } from "@smithy/signature-v4";
import type { Checksum, SourceData } from "@smithy/types";
import { createHash, createHmac, randomBytes, type Hash, type Hmac } from "node:crypto";
import https from "node:https";
import * as v from "valibot";
import {
    guardedHttpsAgent,
    normalizeS3Endpoint,
    type S3BucketUsage,
    type S3Target,
} from "../client";

// The `/rustfs/admin/v3` paths take plain JSON; the MinIO-compatible paths encrypt bodies.
const ADMIN_PATH = "/rustfs/admin/v3";

class NodeSha256 implements Checksum {
    private hash: Hash | Hmac;

    constructor(private readonly secret?: SourceData) {
        this.hash = this.create();
    }

    private create() {
        if (this.secret === undefined) return createHash("sha256");

        return createHmac(
            "sha256",
            this.secret instanceof ArrayBuffer
                ? new Uint8Array(this.secret)
                : ArrayBuffer.isView(this.secret)
                  ? new Uint8Array(
                        this.secret.buffer,
                        this.secret.byteOffset,
                        this.secret.byteLength,
                    )
                  : this.secret,
        );
    }

    update(data: Uint8Array) {
        this.hash.update(data);
    }

    async digest() {
        return new Uint8Array(this.hash.digest());
    }

    reset() {
        this.hash = this.create();
    }
}

function send(url: URL, method: string, headers: Record<string, string>, body: string) {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = https.request(
            url,
            { method, headers, agent: guardedHttpsAgent(), timeout: 10_000 },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        text: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );

        request.on("timeout", () => request.destroy(new Error("RustFS did not respond in time.")));
        request.on("error", reject);
        request.end(body);
    });
}

async function admin(
    target: S3Target,
    method: "GET" | "PUT" | "DELETE",
    operation: string,
    query: Record<string, string>,
    body = "",
) {
    const url = new URL(normalizeS3Endpoint(target.endpoint));
    url.pathname = `${ADMIN_PATH}/${operation}`;
    url.search = new URLSearchParams(query).toString();

    const signer = new SignatureV4({
        service: "s3",
        region: target.region,
        sha256: NodeSha256,
        credentials: {
            accessKeyId: target.credentials.accessKey,
            secretAccessKey: target.credentials.secretKey,
        },
    });

    const signed = await signer.sign({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname,
        query,
        // Content-Length stays unsigned: proxies drop `Content-Length: 0` on a bodiless DELETE,
        // and RustFS then rejects the signature. The body is still covered by its signed hash.
        headers: { host: url.host, "content-type": "application/json" },
        body,
    });

    return send(url, method, signed.headers, body);
}

// RustFS answers with an S3-style XML error; its code and message say why it refused.
function failed(response: { status: number; text: string }) {
    const code = /<Code>(.*?)<\/Code>/.exec(response.text)?.[1];
    const message = /<Message>(.*?)<\/Message>/.exec(response.text)?.[1];
    const reason = code && message ? `${code}: ${message}` : (code ?? message);

    return new Error(
        `RustFS admin request failed with status ${response.status}${reason ? ` (${reason})` : ""}.`,
    );
}

function bucketPolicy(bucket: string) {
    return {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["s3:*"],
                Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
            },
        ],
    };
}

const dataUsage = v.object({
    // Serialized Rust SystemTime; null before the scanner's first cycle.
    last_update: v.nullish(v.object({ secs_since_epoch: v.number() })),
    buckets_usage: v.record(v.string(), v.object({ size: v.number(), objects_count: v.number() })),
});

// The scanner's usage snapshot, the same accounting quotas are enforced against.
// Null when the scanner has not reached this bucket yet.
export async function getRustfsBucketUsage(target: S3Target, bucket: string) {
    const response = await admin(target, "GET", "datausageinfo", {});

    if (response.status >= 300) throw failed(response);

    return parseRustfsBucketUsage(response.text, bucket);
}

export function parseRustfsBucketUsage(body: string, bucket: string): S3BucketUsage | null {
    const info = v.parse(dataUsage, JSON.parse(body));
    const usage = info.buckets_usage[bucket];

    if (!usage || !info.last_update) return null;

    return {
        size: usage.size,
        objects: usage.objects_count,
        measuredAt: new Date(info.last_update.secs_since_epoch * 1000),
    };
}

// A hard byte limit; null clears it. Needs the connection's admin keys, not the bucket's own key.
export async function setRustfsQuota(target: S3Target, bucket: string, quota: number | null) {
    const response =
        quota === null
            ? await admin(target, "DELETE", `quota/${bucket}`, {})
            : await admin(
                  target,
                  "PUT",
                  `quota/${bucket}`,
                  {},
                  JSON.stringify({ quota, quota_type: "HARD" }),
              );

    if (response.status >= 300) throw failed(response);
}

// A key that is already gone counts as revoked, so retried deletions can finish.
export async function deleteRustfsKey(target: S3Target, accessKey: string) {
    const response = await admin(target, "DELETE", "delete-service-account", { accessKey });

    if (response.status >= 300 && !response.text.includes("service account not exist"))
        throw failed(response);
}

// Both keys are chosen here, so a retry can remove a half-finished attempt by its access key.
export async function createRustfsKey(target: S3Target, bucket: string, accessKey: string) {
    await deleteRustfsKey(target, accessKey);

    // RustFS caps secret keys at 40 characters.
    const secretKey = randomBytes(30).toString("base64url");

    const response = await admin(
        target,
        "PUT",
        "add-service-account",
        {},
        JSON.stringify({
            accessKey,
            secretKey,
            description: `Stoat bucket ${bucket}`,
            policy: bucketPolicy(bucket),
        }),
    );

    if (response.status >= 300) throw failed(response);

    return { keyId: accessKey, credentials: { accessKey, secretKey } };
}
