<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import ContainerRowSkeleton from "./container-row-skeleton.svelte";
</script>

<Skeleton loading loading-label="Loading resource">
    <div class="space-y-6">
        <div
            class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0"
        >
            <Frame
                class="w-full min-w-0 xl:col-span-1 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
            >
                <FrameHeader class="shrink-0">
                    <FrameTitle class="text-base">
                        <h2>Containers</h2>
                    </FrameTitle>
                    <FrameDescription class="mt-1">
                        Runtime status across machines.
                    </FrameDescription>
                </FrameHeader>
                <FramePanel
                    class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none"
                >
                    <ContainerRowSkeleton />
                </FramePanel>
            </Frame>
            <Frame
                class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
            >
                <FrameHeader
                    class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
                >
                    <div class="min-w-0">
                        <FrameTitle class="text-base">
                            <h2>Docker Compose</h2>
                        </FrameTitle>
                        <FrameDescription class="mt-1">
                            Edit the Docker Compose YAML for this
                            resource.
                        </FrameDescription>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button variant="secondary" disabled>
                            Preview compose
                        </Button>
                    </div>
                </FrameHeader>
                <FramePanel
                    class="min-h-88 overflow-hidden bg-code p-0 dark:bg-black/20"
                />
            </Frame>
        </div>
    </div>
</Skeleton>
