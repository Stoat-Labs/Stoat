<script lang="ts">
    import {
        Alert,
        AlertDescription,
        AlertTitle,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import CircleAlert from "phosphor-svelte/lib/WarningCircleIcon";
    import { createQuery } from "@tanstack/svelte-query";

    let {
        clusterId,
        onconfigure,
    }: {
        clusterId: string;
        onconfigure: () => void;
    } = $props();

    const caddyQuery = createQuery(() => ({
        ...orpc.cluster.getCaddy.queryOptions({
            input: { clusterId },
        }),
        // Follow a running rollout until it settles.
        refetchInterval: (query) =>
            query.state.data?.activeDeploymentId ? 5000 : false,
    }));

    const caddy = $derived(caddyQuery.data);
</script>

<Frame class="min-w-0">
    <FrameHeader
        class="flex-row items-center justify-between gap-2 px-2.5 py-3"
    >
        <div class="flex min-w-0 items-center gap-2">
            <FrameTitle>Ingress</FrameTitle>
            {#if caddy}
                <Badge
                    variant={caddy.deployed ? "success" : "secondary"}
                >
                    {caddy.deployed ? "Running" : "Not deployed"}
                </Badge>
            {/if}
        </div>
        {#if caddy?.canManage}
            {#if caddy.activeDeploymentId}
                <Button
                    variant="outline"
                    size="sm"
                    href={`/deployments/${caddy.activeDeploymentId}`}
                >
                    View rollout
                </Button>
            {:else}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={onconfigure}
                >
                    Configure
                </Button>
            {/if}
        {/if}
    </FrameHeader>
    <FramePanel class="flex-1 p-0">
        {#if caddyQuery.isPending}
            <Skeleton loading label="Loading Caddy settings">
                <div class="divide-y text-sm">
                    <p class="flex h-11 items-center px-4">
                        Image caddy:2.10.2
                    </p>
                    <p class="flex h-11 items-center px-4">
                        Global Caddyfile not set
                    </p>
                </div>
            </Skeleton>
        {:else if caddyQuery.isError}
            <div class="p-4">
                <Alert variant="error">
                    <CircleAlert aria-hidden="true" />
                    <AlertDescription>
                        Unable to load Caddy settings: {caddyQuery
                            .error.message}
                    </AlertDescription>
                </Alert>
            </div>
        {:else if caddy}
            <dl class="divide-y text-sm">
                <div
                    class="flex h-11 items-center justify-between gap-4 px-4"
                >
                    <dt class="shrink-0 text-muted-foreground">
                        Image
                    </dt>
                    <dd
                        class="min-w-0 truncate font-mono text-[13px]"
                    >
                        {caddy.image || "None"}
                    </dd>
                </div>
                <div
                    class="flex h-11 items-center justify-between gap-4 px-4"
                >
                    <dt class="text-muted-foreground">
                        Global Caddyfile
                    </dt>
                    <dd>{caddy.hasCaddyfile ? "Set" : "Not set"}</dd>
                </div>
            </dl>
            {#if (caddy.monitoring && caddy.missingMetrics.length > 0) || caddy.reconciliationErrors.length > 0}
                <div class="space-y-3 border-t p-4">
                    {#if caddy.monitoring && caddy.missingMetrics.length > 0}
                        <Alert variant="warning">
                            <CircleAlert aria-hidden="true" />
                            <AlertTitle>
                                HTTP traffic is not recorded
                            </AlertTitle>
                            <AlertDescription>
                                <p>
                                    The global <code>metrics</code>
                                    option is missing
                                    {#each caddy.missingMetrics as name, index (name)}{index >
                                        0
                                            ? " and "
                                            : ""}
                                        <code>{name}</code>{/each},
                                    which Clowder needs to record HTTP
                                    traffic.
                                </p>
                                {#if caddy.canManage}
                                    <Button
                                        class="mt-2"
                                        variant="outline"
                                        size="sm"
                                        disabled={!!caddy.activeDeploymentId}
                                        onclick={onconfigure}
                                    >
                                        Fix in Caddy settings
                                    </Button>
                                {/if}
                            </AlertDescription>
                        </Alert>
                    {/if}
                    {#if caddy.reconciliationErrors.length > 0}
                        <Alert variant="warning">
                            <CircleAlert aria-hidden="true" />
                            <AlertTitle>
                                Caddy rejected its latest config
                            </AlertTitle>
                            <AlertDescription>
                                Affected machines keep serving their
                                previous config until the error is
                                fixed.
                                <ul class="mt-2 space-y-1">
                                    {#each caddy.reconciliationErrors as { machine, error } (machine)}
                                        <li class="break-words">
                                            <span class="font-medium">
                                                {machine}:
                                            </span>
                                            <span
                                                class="font-mono text-xs"
                                            >
                                                {error}
                                            </span>
                                        </li>
                                    {/each}
                                </ul>
                            </AlertDescription>
                        </Alert>
                    {/if}
                </div>
            {/if}
        {/if}
    </FramePanel>
</Frame>
