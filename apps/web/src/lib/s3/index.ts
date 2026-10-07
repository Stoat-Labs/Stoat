import type { S3ConnectionInput } from "@stoat/s3";
import type { S3ProviderId } from "@stoat/s3/providers";

export type S3ConnectionDraft = {
    endpoint: string;
    region: string;
    forcePathStyle: boolean;
    accountId: string;
    accessKey: string;
    secretKey: string;
    apiToken: string;
};

// Blank secrets are sent as missing, so a saved connection keeps its stored ones.
export function s3ConnectionInput(
    provider: S3ProviderId,
    draft: S3ConnectionDraft,
): S3ConnectionInput {
    const keys = {
        accessKey: draft.accessKey.trim() || undefined,
        secretKey: draft.secretKey || undefined,
    };

    if (provider === "r2")
        return {
            provider,
            accountId: draft.accountId.trim(),
            apiToken: draft.apiToken || undefined,
        };

    if (provider === "rustfs") return { provider, endpoint: draft.endpoint.trim(), ...keys };

    return {
        provider,
        endpoint: draft.endpoint.trim(),
        region: draft.region.trim(),
        forcePathStyle: draft.forcePathStyle,
        ...keys,
    };
}

export function s3DraftComplete(
    provider: S3ProviderId,
    draft: S3ConnectionDraft,
    requireSecrets: boolean,
) {
    if (provider === "r2")
        return Boolean(draft.accountId.trim() && (!requireSecrets || draft.apiToken));

    return Boolean(
        draft.endpoint.trim() &&
        (provider !== "generic" || draft.region.trim()) &&
        (!requireSecrets || (draft.accessKey.trim() && draft.secretKey)),
    );
}

export const s3BucketStatusVariant = {
    ready: "success",
    provisioning: "info",
    deleting: "warning",
    failed: "error",
} as const;
