<script lang="ts" module>
    import type { S3ProviderId } from "@stoat/s3/providers";

    // Cloudflare is from svgl.app, Amazon S3 from Wikimedia Commons.
    // RustFS publishes no square SVG mark, so its site favicon is used.
    export const s3ProviderIcons: Record<S3ProviderId, string> = {
        generic: "/icons/amazon-s3.svg",
        rustfs: "/icons/rustfs.svg",
        r2: "/icons/cloudflare.svg",
    };
</script>

<script lang="ts">
    import { cn } from "$lib/utils";

    let {
        provider,
        class: className = "size-4",
    }: { provider: S3ProviderId; class?: string } = $props();
</script>

<img
    src={s3ProviderIcons[provider]}
    alt=""
    aria-hidden="true"
    class={cn("shrink-0 object-contain", className)}
/>
