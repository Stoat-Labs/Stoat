<script lang="ts">
    import CreateConnectionDialog from "$lib/components/s3/create-connection-dialog.svelte";
    import ProviderIcon from "$lib/components/s3/provider-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Plus from "@lucide/svelte/icons/plus";
    import { s3Providers } from "@stoat/s3/providers";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { onMount } from "svelte";

    const listQuery = createQuery(() => orpc.s3.list.queryOptions());

    const dialog = useQueryState(
        "dialog",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    let ready = $state(false);

    onMount(() => {
        ready = true;

        return () => {
            ready = false;
        };
    });

    function openCreate() {
        void dialog.set("create-connection");
    }
</script>

<svelte:head><title>S3 connections / Stoat</title></svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
            <h1 class="text-2xl font-semibold">S3 connections</h1>
            <p class="mt-1 text-sm text-muted-foreground">
                Provider accounts that projects provision buckets
                from.
            </p>
        </div>
        <Button disabled={!ready} onclick={openCreate}>
            <Plus aria-hidden="true" />
            Add connection
        </Button>
    </div>

    {#if listQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load connections: {listQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if listQuery.isPending}
        <Skeleton loading loading-label="Loading connections">
            <Frame>
                <FrameHeader>
                    <FrameTitle class="text-base">
                        <h2>Connections</h2>
                    </FrameTitle>
                </FrameHeader>
                <FramePanel class="divide-y divide-border p-0">
                    {#each { length: 3 }, index (index)}
                        <div class="flex items-center gap-3 p-4">
                            <span
                                class="size-9 shrink-0 rounded-full"
                            ></span>
                            <span class="min-w-0 flex-1">
                                <span
                                    class="block text-sm font-medium"
                                >
                                    Connection name
                                </span>
                                <span class="block text-xs">
                                    Provider · https://s3.example.com
                                </span>
                            </span>
                            <span class="shrink-0 text-xs">
                                0 buckets
                            </span>
                        </div>
                    {/each}
                </FramePanel>
            </Frame>
        </Skeleton>
    {:else if listQuery.data.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <HardDrive aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No S3 connections yet</EmptyTitle>
                <EmptyDescription>
                    Connect a provider to provision buckets for your
                    projects.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button
                    size="sm"
                    disabled={!ready}
                    onclick={openCreate}
                >
                    Add connection
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        <Frame role="region" aria-labelledby="connections-heading">
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2 id="connections-heading">Connections</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel class="divide-y divide-border p-0">
                {#each listQuery.data as connection (connection.id)}
                    <a
                        href={`/s3/${connection.id}`}
                        class="group flex items-center gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                    >
                        <span
                            class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                        >
                            <ProviderIcon
                                provider={connection.provider}
                            />
                        </span>
                        <span class="min-w-0 flex-1">
                            <span
                                class="block truncate text-sm font-medium"
                            >
                                {connection.name}
                            </span>
                            <span
                                class="block truncate text-xs text-muted-foreground"
                            >
                                {s3Providers[connection.provider]
                                    .name} · {connection.endpoint}
                            </span>
                        </span>
                        {#if connection.lastTestStatus === "failure"}
                            <Badge variant="error">Test failed</Badge>
                        {/if}
                        <span
                            class="shrink-0 text-xs tabular-nums text-muted-foreground"
                        >
                            {connection.buckets}
                            {connection.buckets === 1
                                ? "bucket"
                                : "buckets"}
                        </span>
                        <ChevronRight
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </a>
                {/each}
            </FramePanel>
        </Frame>
    {/if}
</div>

<CreateConnectionDialog
    bind:open={
        () => dialog.current === "create-connection",
        (open) => {
            if (
                ready &&
                !open &&
                dialog.current === "create-connection"
            )
                void dialog.set(null);
        }
    }
/>
