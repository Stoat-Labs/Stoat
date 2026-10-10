<script lang="ts">
    import ImageIcon from "$lib/components/shared/image-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { containerInfo } from "$lib/resources/container-info";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import ContainerRowSkeleton from "./container-row-skeleton.svelte";

    let {
        containers,
        hasSpec,
        loaded,
        pending,
        errorMessage,
    }: {
        containers: Awaited<
            ReturnType<AppRouterClient["resources"]["getContainers"]>
        >;
        /** Whether a saved or draft Compose spec exists to run containers from. */
        hasSpec: boolean;
        /** Whether the containers query has returned data at least once. */
        loaded: boolean;
        pending: boolean;
        errorMessage: string | undefined;
    } = $props();
</script>

<Frame
    class="w-full min-w-0 xl:min-h-0 xl:flex-1"
    role="region"
    aria-labelledby="containers-heading"
>
    <FrameHeader class="shrink-0">
        <div
            class="flex flex-wrap items-center justify-between gap-2"
        >
            <FrameTitle class="text-base">
                <h2 id="containers-heading">Containers</h2>
            </FrameTitle>
            <span class="text-xs tabular-nums text-muted-foreground">
                {#if hasSpec && loaded}
                    {containers.length}
                    {containers.length === 1
                        ? "container"
                        : "containers"}
                {/if}
            </span>
        </div>
    </FrameHeader>
    <FramePanel
        class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none xl:flex-1"
    >
        {#if !hasSpec}
            <Empty
                class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
            >
                <EmptyHeader>
                    <EmptyDescription>
                        Save a Compose spec to view this resource's
                        containers.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        {:else}
            {#if errorMessage !== undefined}
                <Alert variant="error" class="m-3">
                    <AlertDescription>
                        Unable to load containers: {errorMessage}
                        {#if containers.length > 0}Showing previously
                            loaded containers.{/if}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if pending}
                <Skeleton
                    loading
                    count={2}
                    count-gap={1}
                    loading-label="Loading containers"
                >
                    <ContainerRowSkeleton />
                </Skeleton>
            {:else if containers.length > 0}
                <ul>
                    {#each containers as item, index (`${item.machineId}-${item.container.Id ?? index}`)}
                        {@const info = containerInfo(item.container)}
                        <li class="min-w-0">
                            {#if index > 0}<Separator />{/if}
                            <div
                                class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                            >
                                <ImageIcon image={info.image} />
                                <div class="min-w-0">
                                    <h3
                                        class="truncate text-sm font-medium leading-5"
                                        title={info.name}
                                    >
                                        {info.name}
                                    </h3>
                                    <p
                                        class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                        title={`${info.image} · ${item.machineName || item.machineId || "Unknown machine"}${info.id ? ` · ${info.id}` : ""}`}
                                    >
                                        {info.image}
                                        &middot;
                                        {item.machineName ||
                                            item.machineId ||
                                            "Unknown machine"}
                                        {#if info.id}
                                            &middot;
                                            <span
                                                class="font-mono"
                                                title={info.id}
                                            >
                                                {info.id.slice(0, 12)}
                                            </span>
                                        {/if}
                                    </p>
                                </div>
                                <Badge
                                    variant={info.healthVariant}
                                    class="col-start-2 shrink-0 justify-self-start whitespace-nowrap capitalize sm:col-start-auto sm:justify-self-end"
                                    aria-label={`Health: ${info.health}. Runtime status: ${info.status}`}
                                    title={`Runtime status: ${info.status}`}
                                >
                                    {info.health}
                                </Badge>
                            </div>
                        </li>
                    {/each}
                </ul>
            {:else if errorMessage === undefined}
                <Empty
                    class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                >
                    <EmptyHeader>
                        <EmptyDescription>
                            No containers found.
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            {/if}
        {/if}
    </FramePanel>
</Frame>
