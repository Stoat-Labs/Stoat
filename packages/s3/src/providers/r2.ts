import { createHash } from "node:crypto";
import type { S3Credentials } from "../client";

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
