<script lang="ts">
    import {
        Alert,
        AlertDescription,
        AlertTitle,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
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

<Card>
    <CardHeader
        class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
        <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
                <CardTitle class="text-base">Ingress proxy</CardTitle>
                {#if caddy}
                    <Badge
                        variant={caddy.deployed
                            ? "success"
                            : "secondary"}
                    >
                        {caddy.deployed
                            ? "Caddy running"
                            : "Not deployed"}
                    </Badge>
                {/if}
            </div>
            <CardDescription class="mt-1">
                Caddy runs on every machine and routes HTTP(S) traffic
                to services.
            </CardDescription>
        </div>
        {#if caddy?.canManage}
            <div class="flex shrink-0 flex-wrap items-center gap-2">
                {#if caddy.activeDeploymentId}
                    <Button
                        variant="ghost"
                        size="sm"
                        href={`/deployments/${caddy.activeDeploymentId}`}
                    >
                        View rollout
                    </Button>
                {/if}
                <Button
                    variant="outline"
                    size="sm"
                    disabled={!!caddy.activeDeploymentId}
                    onclick={onconfigure}
                >
                    Configure Caddy
                </Button>
            </div>
        {/if}
    </CardHeader>
    <CardPanel class="space-y-3 p-4 pt-0 sm:p-5 sm:pt-0">
        {#if caddyQuery.isPending}
            <Skeleton loading loading-label="Loading Caddy settings">
                <p class="text-sm">Image caddy:2.10.2</p>
                <p class="text-sm">Global Caddyfile not set</p>
            </Skeleton>
        {:else if caddyQuery.isError}
            <Alert variant="error">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>
                    Unable to load Caddy settings: {caddyQuery.error
                        .message}
                </AlertDescription>
            </Alert>
        {:else if caddy}
            <dl class="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
                <dt class="text-muted-foreground">Image</dt>
                <dd class="min-w-0 truncate font-mono text-[13px]">
                    {caddy.image || "None"}
                </dd>
                <dt class="text-muted-foreground">
                    Global Caddyfile
                </dt>
                <dd>
                    {caddy.hasCaddyfile ? "Set" : "Not set"}
                </dd>
            </dl>
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
                                <code>{name}</code>{/each}, which
                            Stoat needs to record HTTP traffic.
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
                        Affected machines keep serving their previous
                        config until the error is fixed.
                        <ul class="mt-2 space-y-1">
                            {#each caddy.reconciliationErrors as { machine, error } (machine)}
                                <li class="break-words">
                                    <span class="font-medium">
                                        {machine}:
                                    </span>
                                    <span class="font-mono text-xs">
                                        {error}
                                    </span>
                                </li>
                            {/each}
                        </ul>
                    </AlertDescription>
                </Alert>
            {/if}
        {/if}
    </CardPanel>
</Card>
