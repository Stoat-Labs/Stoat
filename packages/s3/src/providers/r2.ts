import { createHash } from "node:crypto";
import * as v from "valibot";
import type { S3BucketUsage, S3Credentials } from "../client";

const API = "https://api.cloudflare.com/client/v4";

const BUCKET_WRITE_PERMISSION = "Workers R2 Storage Bucket Item Write";

type CloudflareResponse<T> = {
    success: boolean;
    result: T;
    result_info?: { page: number; total_pages: number };
};

async function cloudflare<T>(token: string, path: string, init: RequestInit = {}) {
    const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
    });

    // SAFETY: every Cloudflare v4 endpoint wraps results in this envelope; `success` is checked below.
    const parsed = (await response.json().catch(() => null)) as CloudflareResponse<T> | null;

    if (!response.ok || !parsed?.success)
        throw new Error(`Cloudflare API request failed with status ${response.status}.`);

    return parsed;
}

export function r2Endpoint(accountId: string) {
    return `https://${accountId}.r2.cloudflarestorage.com`;
}

// R2's S3 keys are derived from an API token: the token ID and the SHA-256 of its value.
function s3Credentials(tokenId: string, tokenValue: string): S3Credentials {
    return {
        accessKey: tokenId,
        secretKey: createHash("sha256").update(tokenValue).digest("hex"),
    };
}

export async function r2ConnectionCredentials(accountId: string, apiToken: string) {
    const { result } = await cloudflare<{ id: string; status: string }>(
        apiToken,
        `/accounts/${accountId}/tokens/verify`,
    );

    if (result.status !== "active") throw new Error("The Cloudflare API token is not active.");

    return s3Credentials(result.id, apiToken);
}

// Revokes every token with this name. Finding none counts as revoked, so retries can finish.
export async function deleteR2Key(accountId: string, apiToken: string, name: string) {
    const ids: string[] = [];

    for (let page = 1, pages = 1; page <= pages; page++) {
        const response = await cloudflare<{ id: string; name: string }[]>(
            apiToken,
            `/accounts/${accountId}/tokens?per_page=50&page=${page}`,
        );

        pages = response.result_info?.total_pages ?? 1;

        for (const token of response.result) if (token.name === name) ids.push(token.id);
    }

    for (const id of ids)
        await cloudflare(apiToken, `/accounts/${accountId}/tokens/${id}`, { method: "DELETE" });
}

// Token names are deterministic, so a retry removes tokens left by a failed attempt first.
export async function createR2Key(
    accountId: string,
    apiToken: string,
    bucket: string,
    name: string,
) {
    await deleteR2Key(accountId, apiToken, name);

    const { result: groups } = await cloudflare<{ id: string; name: string }[]>(
        apiToken,
        `/accounts/${accountId}/tokens/permission_groups`,
    );

    const permission = groups.find((group) => group.name === BUCKET_WRITE_PERMISSION);

    if (!permission) throw new Error("Cloudflare did not return the R2 bucket permission group.");

    const { result } = await cloudflare<{ id: string; value: string }>(
        apiToken,
        `/accounts/${accountId}/tokens`,
        {
            method: "POST",
            body: JSON.stringify({
                name,
                policies: [
                    {
                        effect: "allow",
                        resources: {
                            [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*",
                        },
                        permission_groups: [{ id: permission.id }],
                    },
                ],
            }),
        },
    );

    return { keyId: result.id, credentials: s3Credentials(result.id, result.value) };
}

const storageMetrics = v.object({
    data: v.nullable(
        v.object({
            viewer: v.object({
                accounts: v.array(
                    v.object({
                        r2StorageAdaptiveGroups: v.array(
                            v.object({
                                max: v.object({ objectCount: v.number(), payloadSize: v.number() }),
                                dimensions: v.object({ datetime: v.string() }),
                            }),
                        ),
                    }),
                ),
            }),
        }),
    ),
    errors: v.nullish(v.array(v.object({ message: v.string() }))),
});

// Cloudflare's storage analytics, the same source `wrangler r2 bucket info` reads. Needs the
// token's Account Analytics: Read permission. Null when R2 reported nothing in the last day.
export async function getR2BucketUsage(
    accountId: string,
    apiToken: string,
    bucket: string,
): Promise<S3BucketUsage | null> {
    const now = new Date();

    const response = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
            query: `query ($accountTag: String, $filter: R2StorageAdaptiveGroupsFilter_InputObject) {
                viewer {
                    accounts(filter: { accountTag: $accountTag }) {
                        r2StorageAdaptiveGroups(limit: 1, filter: $filter, orderBy: [datetime_DESC]) {
                            max { objectCount payloadSize }
                            dimensions { datetime }
                        }
                    }
                }
            }`,
            variables: {
                accountTag: accountId,
                filter: {
                    bucketName: bucket,
                    datetime_geq: new Date(now.getTime() - 86_400_000).toISOString(),
                    datetime_leq: now.toISOString(),
                },
            },
        }),
    });

    const parsed = v.safeParse(storageMetrics, await response.json().catch(() => null));

    if (!response.ok || !parsed.success || parsed.output.errors?.length)
        throw new Error(
            `Cloudflare analytics request failed with status ${response.status}${
                parsed.success && parsed.output.errors?.[0]
                    ? ` (${parsed.output.errors[0].message})`
                    : ""
            }.`,
        );

    const latest = parsed.output.data?.viewer.accounts[0]?.r2StorageAdaptiveGroups[0];

    if (!latest) return null;

    return {
        size: latest.max.payloadSize,
        objects: latest.max.objectCount,
        measuredAt: new Date(latest.dimensions.datetime),
    };
}
