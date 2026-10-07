<script lang="ts">
    import BucketDetail from "$lib/components/s3/bucket-detail.svelte";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { ago } from "$lib/format";
    import { bytes } from "$lib/observability";
    import { cn } from "$lib/utils";
    import type { S3BucketMetadata } from "@stoat/db/schema/index";
    import { defineChart } from "@tanstack/charts";
    import { pie, polar, radialArc } from "@tanstack/charts/polar";
    import { Chart } from "@tanstack/charts/svelte";

    let {
        usage,
        quota,
    }: { usage: S3BucketMetadata | null; quota: number | null } =
        $props();

    const size = $derived(usage?.size ?? 0);

    // Can pass 100%: RustFS counts usage with a delay, and a limit can be set below current usage.
    const percent = $derived(quota ? (size / quota) * 100 : null);

    // Without a limit the ring is only a track, so it never reads as "full".
    const parts = $derived(
        quota
            ? [
                  { id: "used", value: Math.min(size, quota) },
                  { id: "free", value: Math.max(quota - size, 0) },
              ]
            : [{ id: "free", value: 1 }],
    );

    const definition = $derived(
        defineChart({
            marks: [
                polar({
                    inset: 2,
                    radiusRatio: 1,
                    marks: [
                        radialArc(pie(parts, { value: "value" }), {
                            innerRadius: ({ radius }) => radius * 0.8,
                            cornerRadius: 4,
                            color: "id",
                            key: "id",
                        }),
                    ],
                    scales: { angle: null, radius: null },
                }),
            ],
            scales: { x: null, y: null },
            // Palette order: --ts-chart-1 is used space, --ts-chart-2 the remaining track.
            color: { domain: ["used", "free"] },
            keyboard: false,
        }),
    );

    const level = $derived(
        percent === null || percent < 80
            ? "[--ts-chart-1:var(--chart-1)]"
            : percent < 100
              ? "[--ts-chart-1:var(--warning)]"
              : "[--ts-chart-1:var(--destructive)]",
    );
</script>

<Frame
    class="min-w-0"
    role="region"
    aria-labelledby="bucket-usage-heading"
>
    <FrameHeader>
        <FrameTitle class="text-base">
            <h2 id="bucket-usage-heading">Usage</h2>
        </FrameTitle>
    </FrameHeader>
    <FramePanel class="p-0">
        {#if usage}
            <div class="flex items-center gap-5 p-4">
                <div class="relative size-28 shrink-0">
                    <Chart
                        {definition}
                        ariaLabel={percent === null
                            ? `${bytes(size)} used, no storage limit`
                            : `${bytes(size)} of ${bytes(quota)} used`}
                        width={112}
                        height={112}
                        tabIndex={-1}
                        class={cn(
                            "[--ts-chart-2:color-mix(in_srgb,var(--muted-foreground)_20%,transparent)]",
                            level,
                        )}
                    />
                    {#if percent !== null}
                        <span
                            class="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums"
                            aria-hidden="true"
                        >
                            {Math.round(percent)}%
                        </span>
                    {/if}
                </div>
                <div class="min-w-0">
                    <p class="text-2xl font-semibold tabular-nums">
                        {bytes(size)}
                    </p>
                    <p class="text-sm text-muted-foreground">
                        {quota
                            ? `of ${bytes(quota)}`
                            : "No storage limit"}
                    </p>
                </div>
            </div>
            <dl class="border-t py-1">
                <BucketDetail
                    inline
                    label="Objects"
                    value={usage.objects.toLocaleString()}
                />
                <BucketDetail
                    inline
                    label="Measured"
                    value={ago(usage.measuredAt, Date.now())}
                />
            </dl>
        {:else}
            <p class="p-4 text-sm text-muted-foreground">
                Not measured yet. Stoat checks bucket usage every
                hour.
            </p>
        {/if}
    </FramePanel>
</Frame>
