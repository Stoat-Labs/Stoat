import { S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { lookup } from "node:dns";
import { Agent } from "node:https";
import { BlockList, isIP } from "node:net";

export type S3Credentials = { accessKey: string; secretKey: string };

// Everything needed to talk S3 to one provider account.
export type S3Target = {
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    credentials: S3Credentials;
};

const blocked = new BlockList();

for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] satisfies [string, number][]) {
    blocked.addSubnet(address, prefix);
}

blocked.addAddress("168.63.129.16");

export function isPublicS3Address(address: string) {
    if (isIP(address) === 4) return !blocked.check(address);

    if (isIP(address) !== 6) return false;
    const normalized = new URL(`https://[${address}]`).hostname.slice(1, -1);
    const first = Number.parseInt(normalized.split(":")[0]!, 16);
    const second = Number.parseInt(normalized.split(":")[1] || "0", 16);

    return (
        first >= 0x2000 &&
        first < 0x3fff &&
        first !== 0x2002 &&
        !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    );
}

export function normalizeS3Endpoint(value: string) {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");

    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (isIP(hostname) && !isPublicS3Address(hostname))
    ) {
        throw new Error(
            "Use a public HTTPS endpoint without a bucket path, credentials, query, or fragment.",
        );
    }

    return url.origin;
}

// DNS is checked by the socket lookup itself so rebinding cannot bypass the policy.
export function guardedHttpsAgent() {
    return new Agent({
        lookup: (hostname, options, callback) => {
            lookup(hostname, { all: true }, (error, addresses) => {
                if (
                    error ||
                    !addresses.length ||
                    addresses.some(({ address }) => !isPublicS3Address(address))
                ) {
                    callback(new Error("S3 endpoint is not publicly reachable"), [], undefined);

                    return;
                }

                if (options.all) callback(null, addresses);
                else callback(null, addresses[0]!.address, addresses[0]!.family);
            });
        },
    });
}

export function createS3Client(target: S3Target) {
    return new S3Client({
        endpoint: normalizeS3Endpoint(target.endpoint),
        region: target.region,
        forcePathStyle: target.forcePathStyle,
        credentials: {
            accessKeyId: target.credentials.accessKey,
            secretAccessKey: target.credentials.secretKey,
        },
        maxAttempts: 1,
        requestHandler: new NodeHttpHandler({
            connectionTimeout: 5_000,
            requestTimeout: 10_000,
            httpsAgent: guardedHttpsAgent(),
        }),
    });
}

export function s3ErrorCode(error: Error) {
    return error instanceof S3ServiceException ? error.name : null;
}

// Fixed messages only: provider errors can echo request details back.
export function s3ErrorMessage(error: Error) {
    const code = s3ErrorCode(error);

    if (
        code === "AccessDenied" ||
        code === "InvalidAccessKeyId" ||
        code === "SignatureDoesNotMatch"
    )
        return "The credentials do not permit this operation.";

    if (code === "NoSuchBucket") return "The bucket was not found.";

    if (code === "BucketAlreadyExists") return "This bucket name is already taken.";

    if (error.name === "TimeoutError" || error.name === "AbortError")
        return "The S3 endpoint did not respond in time.";

    return "Unable to reach S3. Check the endpoint, credentials, and addressing style.";
}

// Safe to show users: S3 errors map to fixed text, and our own provider errors carry no secrets.
export function s3FailureMessage(error: Error) {
    return s3ErrorCode(error) ? s3ErrorMessage(error) : error.message.slice(0, 300);
}
