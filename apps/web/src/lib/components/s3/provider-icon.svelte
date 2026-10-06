<script lang="ts">
    import type { S3ProviderId } from "@stoat/s3/providers";
    import { cn } from "$lib/utils";

    let {
        provider,
        class: className = "size-4",
    }: { provider: S3ProviderId; class?: string } = $props();

    // Cloudflare is from svgl.app, Amazon S3 from Wikimedia Commons.
    // RustFS publishes no square SVG mark, so its site favicon is used.
    const icons: Record<S3ProviderId, string> = {
        generic: "/icons/amazon-s3.svg",
        rustfs: "/icons/rustfs.svg",
        r2: "/icons/cloudflare.svg",
    };
</script>

<img
    src={icons[provider]}
    alt=""
    aria-hidden="true"
    class={cn("shrink-0 object-contain", className)}
/>
