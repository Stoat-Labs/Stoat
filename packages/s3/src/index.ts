import {
    type BucketLocationConstraint,
    CreateBucketCommand,
    DeleteBucketCommand,
    GetObjectCommand,
    ListBucketsCommand,
    ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as v from "valibot";
import {
    createS3Client,
    normalizeS3Endpoint,
    s3ErrorCode,
    type S3BucketUsage,
    type S3Credentials,
    type S3Target,
} from "./client";
import type { S3ProviderId } from "./providers/index";
import {
    createR2Key,
    deleteR2Key,
    getR2BucketUsage,
    r2ConnectionCredentials,
    r2Endpoint,
} from "./providers/r2";
import {
    createRustfsKey,
    deleteRustfsKey,
    getRustfsBucketUsage,
    setRustfsQuota,
} from "./providers/rustfs";
import { decryptS3Secret, encryptS3Secret } from "./secrets";

export {
    normalizeS3Endpoint,
    s3ErrorMessage,
    s3FailureMessage,
    type S3Credentials,
    type S3Target,
} from "./client";

export { s3Providers, type S3ProviderId } from "./providers/index";

const endpoint = v.pipe(
    v.string(),
    v.trim(),
    v.url(),
    v.maxLength(2048),
    v.check((value) => {
        try {
            normalizeS3Endpoint(value);

            return true;
        } catch {
            return false;
        }
    }, "Use an HTTPS endpoint without a path, credentials, query, or fragment."),
    v.transform(normalizeS3Endpoint),
);

const accessKey = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1024));

const secret = v.pipe(v.string(), v.minLength(1), v.maxLength(4096));

type S3KeyPair = { accessKey?: string; secretKey?: string };

// Secrets are optional so edits can keep stored values; creation requires them.
export type S3ConnectionInput =
    | ({
          provider: "generic";
          endpoint: string;
          region: string;
          forcePathStyle: boolean;
      } & S3KeyPair)
    | ({ provider: "rustfs"; endpoint: string } & S3KeyPair)
    | { provider: "r2"; accountId: string; apiToken?: string };

// Typed explicitly: the inferred pipe types are too large for router declaration emit.
export const s3ConnectionInput: v.GenericSchema<S3ConnectionInput> = v.variant("provider", [
    v.object({
        provider: v.literal("generic"),
        endpoint,
        region: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9-]{1,32}$/, "Enter a valid region.")),
        forcePathStyle: v.boolean(),
        accessKey: v.optional(accessKey),
        secretKey: v.optional(secret),
    }),
    v.object({
        provider: v.literal("rustfs"),
        endpoint,
        accessKey: v.optional(accessKey),
        secretKey: v.optional(secret),
    }),
    v.object({
        provider: v.literal("r2"),
        accountId: v.pipe(
            v.string(),
            v.trim(),
            v.regex(/^[a-f0-9]{32}$/, "Enter the 32-character Cloudflare account ID."),
        ),
        apiToken: v.optional(secret),
    }),
]);

// Lowercase letters, digits, and hyphens only; dots break virtual-host TLS.
export const s3BucketName = v.pipe(
    v.string(),
    v.trim(),
    v.regex(
        /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
        "Use 3-63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.",
    ),
);

// The persisted connection, as stored in `s3_connections`.
export type S3ConnectionRecord = {
    id: string;
    organizationId: string;
    provider: S3ProviderId;
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    encryptedCredentials: string;
    providerAccountId: string | null;
    encryptedApiToken: string | null;
};

export type S3ConnectionColumns = Omit<S3ConnectionRecord, "id" | "organizationId">;

export function hasS3ConnectionSecrets(input: S3ConnectionInput) {
    return input.provider === "r2"
        ? Boolean(input.apiToken)
        : Boolean(input.accessKey && input.secretKey);
}

// Turns validated input into stored columns. The input must carry its secrets.
export async function resolveS3Connection(
    input: S3ConnectionInput,
    organizationId: string,
    connectionId: string,
): Promise<S3ConnectionColumns> {
    const scope = { organizationId, connectionId };

    if (input.provider === "r2") {
        if (!input.apiToken) throw new Error("Enter the Cloudflare API token.");

        const credentials = await r2ConnectionCredentials(input.accountId, input.apiToken);

        return {
            provider: "r2",
            endpoint: r2Endpoint(input.accountId),
            region: "auto",
            forcePathStyle: false,
            encryptedCredentials: encryptS3Secret(JSON.stringify(credentials), {
                kind: "connection-credentials",
                ...scope,
            }),
            providerAccountId: input.accountId,
            encryptedApiToken: encryptS3Secret(input.apiToken, {
                kind: "connection-api-token",
                ...scope,
            }),
        };
    }

    if (!input.accessKey || !input.secretKey) throw new Error("Enter both access keys.");

    const credentials: S3Credentials = { accessKey: input.accessKey, secretKey: input.secretKey };

    return {
        provider: input.provider,
        endpoint: input.endpoint,
        region: input.provider === "generic" ? input.region : "us-east-1",
        // RustFS is commonly served without wildcard DNS for bucket subdomains.
        forcePathStyle: input.provider === "generic" ? input.forcePathStyle : true,
        encryptedCredentials: encryptS3Secret(JSON.stringify(credentials), {
            kind: "connection-credentials",
            ...scope,
        }),
        providerAccountId: null,
        encryptedApiToken: null,
    };
}

const storedCredentials = v.object({ accessKey: v.string(), secretKey: v.string() });

export function s3ConnectionTarget(connection: S3ConnectionRecord): S3Target {
    const plaintext = decryptS3Secret(connection.encryptedCredentials, {
        kind: "connection-credentials",
        organizationId: connection.organizationId,
        connectionId: connection.id,
    });

    return {
        endpoint: connection.endpoint,
        region: connection.region,
        forcePathStyle: connection.forcePathStyle,
        credentials: v.parse(storedCredentials, JSON.parse(plaintext)),
    };
}

function apiToken(connection: S3ConnectionRecord) {
    if (!connection.encryptedApiToken || !connection.providerAccountId)
        throw new Error("This R2 connection is missing its API token.");

    return {
        accountId: connection.providerAccountId,
        token: decryptS3Secret(connection.encryptedApiToken, {
            kind: "connection-api-token",
            organizationId: connection.organizationId,
            connectionId: connection.id,
        }),
    };
}

// Lists buckets, which proves both reachability and that the keys are account-level.
export async function testS3Connection(connection: S3ConnectionRecord) {
    const client = createS3Client(s3ConnectionTarget(connection));

    try {
        await client.send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(10_000) });
    } finally {
        client.destroy();
    }
}

export async function createS3Bucket(connection: S3ConnectionRecord, bucket: string) {
    const client = createS3Client(s3ConnectionTarget(connection));

    // AWS rejects CreateBucket outside us-east-1 unless the region is repeated here.
    const located = connection.region !== "us-east-1" && connection.region !== "auto";

    try {
        const command = new CreateBucketCommand({
            Bucket: bucket,
            CreateBucketConfiguration: located
                ? // SAFETY: the SDK types only AWS regions; S3-compatible providers accept their own.
                  { LocationConstraint: connection.region as BucketLocationConstraint }
                : undefined,
        });

        await client.send(command, {
            abortSignal: AbortSignal.timeout(15_000),
        });
    } catch (error) {
        // A retry after a partial attempt finds its own bucket already there.
        if (!(error instanceof Error) || s3ErrorCode(error) !== "BucketAlreadyOwnedByYou")
            throw error;
    } finally {
        client.destroy();
    }
}

// Never empties a bucket: data is kept unless the bucket is already empty.
export async function deleteS3BucketIfEmpty(connection: S3ConnectionRecord, bucket: string) {
    const client = createS3Client(s3ConnectionTarget(connection));

    try {
        await client.send(new DeleteBucketCommand({ Bucket: bucket }), {
            abortSignal: AbortSignal.timeout(15_000),
        });

        return "deleted" as const;
    } catch (error) {
        const code = error instanceof Error ? s3ErrorCode(error) : null;

        if (code === "BucketNotEmpty") return "kept" as const;

        if (code === "NoSuchBucket") return "missing" as const;

        throw error;
    } finally {
        client.destroy();
    }
}

export type S3BucketKey = { keyId: string; credentials: S3Credentials };

// Keys are named after their resource, so they can be found and revoked without stored state.
function keyName(resourceId: string) {
    return `stoat-${resourceId}`;
}

// Returns null when the provider cannot scope keys; such buckets share the connection keys.
export async function createS3BucketKey(
    connection: S3ConnectionRecord,
    bucket: string,
    resourceId: string,
): Promise<S3BucketKey | null> {
    const name = keyName(resourceId);

    if (connection.provider === "rustfs")
        return createRustfsKey(s3ConnectionTarget(connection), bucket, name);

    if (connection.provider === "r2") {
        const { accountId, token } = apiToken(connection);

        return createR2Key(accountId, token, bucket, name);
    }

    return null;
}

// Revokes by name, so a key a failed attempt never recorded is revoked too.
export async function deleteS3BucketKey(connection: S3ConnectionRecord, resourceId: string) {
    if (connection.provider === "rustfs")
        await deleteRustfsKey(s3ConnectionTarget(connection), keyName(resourceId));

    if (connection.provider === "r2") {
        const { accountId, token } = apiToken(connection);
        await deleteR2Key(accountId, token, keyName(resourceId));
    }
}

// Applies the limit where the provider enforces it (see `enforcedQuota`); elsewhere it is display-only.
export async function setS3BucketQuota(
    connection: S3ConnectionRecord,
    bucket: string,
    quota: number | null,
) {
    if (connection.provider === "rustfs")
        await setRustfsQuota(s3ConnectionTarget(connection), bucket, quota);
}

export function encryptS3BucketCredentials(credentials: S3Credentials, resourceId: string) {
    return encryptS3Secret(JSON.stringify(credentials), { kind: "bucket-credentials", resourceId });
}

export function decryptS3BucketCredentials(envelope: string, resourceId: string): S3Credentials {
    const plaintext = decryptS3Secret(envelope, { kind: "bucket-credentials", resourceId });

    return v.parse(storedCredentials, JSON.parse(plaintext));
}

// Scoped buckets use their own key; others share the connection's keys.
export function s3BucketTarget(
    connection: S3ConnectionRecord,
    resourceId: string,
    encryptedCredentials: string | null,
): S3Target {
    const target = s3ConnectionTarget(connection);

    return encryptedCredentials
        ? { ...target, credentials: decryptS3BucketCredentials(encryptedCredentials, resourceId) }
        : target;
}

// Generic S3 has no usage API, so the bucket is walked one ListObjectsV2 page (up to 1000 keys) at a time.
async function listBucketUsage(
    target: S3Target,
    bucket: string,
    signal: AbortSignal,
): Promise<S3BucketUsage> {
    const client = createS3Client(target);
    let size = 0;
    let objects = 0;
    let cursor: string | undefined;

    try {
        do {
            const result = await client.send(
                new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: cursor }),
                { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
            );

            for (const item of result.Contents ?? []) {
                size += item.Size ?? 0;
                objects += 1;
            }

            cursor = result.NextContinuationToken;
        } while (cursor);
    } finally {
        client.destroy();
    }

    return { size, objects, measuredAt: new Date() };
}

// Asks the provider's own usage API where one exists. Null when the provider has not measured the bucket yet.
export async function getS3BucketUsage(
    connection: S3ConnectionRecord,
    bucket: string,
    signal: AbortSignal,
): Promise<S3BucketUsage | null> {
    if (connection.provider === "rustfs")
        return getRustfsBucketUsage(s3ConnectionTarget(connection), bucket);

    if (connection.provider === "r2") {
        const { accountId, token } = apiToken(connection);

        return getR2BucketUsage(accountId, token, bucket);
    }

    return listBucketUsage(s3ConnectionTarget(connection), bucket, signal);
}

export async function listS3Objects(
    target: S3Target,
    bucket: string,
    prefix: string,
    cursor?: string,
) {
    const client = createS3Client(target);

    try {
        const result = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                Delimiter: "/",
                MaxKeys: 100,
                ContinuationToken: cursor,
            }),
            { abortSignal: AbortSignal.timeout(10_000) },
        );

        return {
            items: (result.Contents ?? []).map((item) => ({
                key: item.Key ?? "",
                size: item.Size ?? 0,
                lastModified: item.LastModified ?? null,
            })),
            prefixes: (result.CommonPrefixes ?? []).flatMap((item) =>
                item.Prefix ? [item.Prefix] : [],
            ),
            cursor: result.NextContinuationToken ?? null,
        };
    } finally {
        client.destroy();
    }
}

export async function s3DownloadUrl(target: S3Target, bucket: string, key: string) {
    const client = createS3Client(target);

    try {
        return await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
            expiresIn: 60,
        });
    } finally {
        client.destroy();
    }
}
