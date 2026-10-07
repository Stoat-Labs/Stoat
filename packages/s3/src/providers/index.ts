// Client-safe provider catalog. Provider API clients live beside it; `../index.ts` wires them up.

export const S3_PROVIDER_IDS = ["generic", "rustfs", "r2"] as const;

export type S3ProviderId = (typeof S3_PROVIDER_IDS)[number];

export type S3ProviderInfo = {
    id: S3ProviderId;
    name: string;
    description: string;
    // Whether each bucket gets its own access key; otherwise buckets share the connection's keys.
    scopedKeys: boolean;
    // Whether the provider rejects writes over a bucket's storage limit; otherwise it is display-only.
    enforcedQuota: boolean;
};

export const s3Providers = {
    generic: {
        id: "generic",
        name: "Generic S3",
        description: "Any S3-compatible endpoint. Buckets share this connection's access keys.",
        scopedKeys: false,
        enforcedQuota: false,
    },
    rustfs: {
        id: "rustfs",
        name: "RustFS",
        description: "Self-hosted RustFS. Each bucket gets its own service account.",
        scopedKeys: true,
        enforcedQuota: true,
    },
    r2: {
        id: "r2",
        name: "Cloudflare R2",
        description: "Cloudflare R2 storage. Each bucket gets its own scoped API token.",
        scopedKeys: true,
        enforcedQuota: false,
    },
} as const satisfies Record<S3ProviderId, S3ProviderInfo>;

export function isS3ProviderId(value: string): value is S3ProviderId {
    return S3_PROVIDER_IDS.some((id) => id === value);
}
