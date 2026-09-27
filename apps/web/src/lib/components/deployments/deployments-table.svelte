<script lang="ts">
    import { goto } from "$app/navigation";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { DataTable } from "$lib/components/ui/data-table";
    import { TableCell, TableHead, TableRow } from "$lib/components/ui/table";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { listPageSize, pageParser } from "$lib/query-params";
    import { createQuery } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { parseAsStringLiteral, useQueryStates } from "nuqs-svelte";
    import { onMount } from "svelte";

    let { resourceId }: { resourceId?: string } = $props();

    const limit = listPageSize;

    type StatusFilter = "all" | "queued" | "running" | "ready" | "failed" | "cancelled";

    const filters: { value: StatusFilter; label: string }[] = [
        { value: "all", label: "All" },
        { value: "queued", label: "Queued" },
        { value: "running", label: "Running" },
        { value: "ready", label: "Ready" },
        { value: "failed", label: "Failed" },
        { value: "cancelled", label: "Cancelled" },
    ];

    const list = useQueryStates(
        {
            status: parseAsStringLiteral(filters.map((filter) => filter.value)).withDefault("all"),
            page: pageParser,
        },
        { shallow: true, scroll: false },
    );

    const deploymentsQuery = createQuery(() =>
        orpc.cluster.listAllDeployments.queryOptions({
            input: {
                status: list.status.current === "all" ? undefined : list.status.current,
                limit,
                offset: (list.page.current - 1) * limit,
                resourceId,
            },
        }),
    );

    let watchError = $state("");

    useHeaderActions(statusFilters);

    onMount(() => {
        let stopped = false;
        const queryKey = orpc.cluster.listAllDeployments.key();

        const stop = subscribeToStream(
            (signal) => client.cluster.watchDeployments(undefined, { signal }),
            () => {
                watchError = "";

                // Cancel even the initial fetch: it may predate subscription readiness.
                void queryClient.cancelQueries({ queryKey }).then(() => {
                    if (!stopped) void queryClient.invalidateQueries({ queryKey });
                });
            },
            (error, reconnecting) => {
                watchError = `${error instanceof Error ? error.message : "Live updates unavailable."}${reconnecting ? " Reconnecting..." : " Reload the page to reconnect."}`;
            },
        );

        return () => {
            stopped = true;
            stop();
        };
    });

    const items = $derived(deploymentsQuery.data?.items ?? []);

    const total = $derived(deploymentsQuery.data?.total ?? 0);

    const totalPages = $derived(Math.max(1, Math.ceil(total / limit)));

    $effect(() => {
        if (deploymentsQuery.isSuccess && !deploymentsQuery.isFetching && list.page.current > totalPages) {
            void list.set({ page: totalPages });
        }
    });

    const meta = $derived(
        total === 0
            ? "0 of 0"
            : `${(list.page.current - 1) * limit + 1}–${Math.min(list.page.current * limit, total)} of ${total}`,
    );

    function deploymentHref(deployment: { id: string; projectId: string | null }) {
        return resourceId && deployment.projectId
            ? `/projects/${deployment.projectId}/${resourceId}/deployments/${deployment.id}`
            : `/deployments/${deployment.id}`;
    }

    function statusVariant(status: string): "success" | "warning" | "error" | "secondary" {
        return status === "ready"
            ? "success"
            : status === "failed"
              ? "error"
              : status === "queued" || status === "running"
                ? "warning"
                : "secondary";
    }

    function statusLabel(status: string) {
        return Match.value(status).pipe(
            Match.when("queued", () => "Queued"),
            Match.when("running", () => "Running"),
            Match.when("ready", () => "Ready"),
            Match.when("failed", () => "Failed"),
            Match.when("cancelled", () => "Cancelled"),
            Match.orElse(() => status),
        );
    }

    function formatDuration(item: { createdAt: Date | string; finishedAt: Date | string | null }) {
        const start = new Date(item.createdAt).getTime();
        const end = item.finishedAt ? new Date(item.finishedAt).getTime() : Date.now();
        const seconds = Math.max(0, Math.floor((end - start) / 1000));

        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
</script>

{#snippet statusFilters()}
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
        {#each filters as filter (filter.value)}
            <Button
                size="sm"
                variant={list.status.current === filter.value ? "default" : "outline"}
                onclick={() => {
                    if (list.status.current !== filter.value) {
                        void list.set({ status: filter.value, page: 1 }, { history: "push" });
                    }
                }}
            >
                {filter.label}
            </Button>
        {/each}
    </div>
{/snippet}

<div class="w-full space-y-6 py-6">

    {#if watchError}
        <Alert variant="warning"><AlertDescription>{watchError}</AlertDescription></Alert>
    {/if}

    {#if deploymentsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load deployments: {deploymentsQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <DataTable
            title="Deployments"
            {meta}
            loading={deploymentsQuery.isPending}
            loadingRows={5}
            colSpan={resourceId ? 5 : 7}
            isEmpty={items.length === 0}
            emptyTitle={list.status.current === "all" ? "No deployments yet" : `No ${list.status.current} deployments`}
            emptyDescription={list.status.current === "all"
                ? resourceId
                    ? "Deploy this resource to create its first deployment."
                    : "Deploy a resource or initialize cluster monitoring to create the first deployment."
                : "No deployments currently match this filter."}
            bind:page={() => list.page.current, (page) => { void list.set({ page }, { history: "push" }); }}
            {totalPages}
        >
            {#snippet header()}
                <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Deployment</TableHead>
                    <TableHead>Cluster</TableHead>
                    {#if !resourceId}
                        <TableHead class="hidden md:table-cell">Project</TableHead>
                        <TableHead class="hidden md:table-cell">Resource</TableHead>
                    {/if}
                    <TableHead class="hidden md:table-cell">Created</TableHead>
                    <TableHead class="text-right">Duration</TableHead>
                </TableRow>
            {/snippet}
            {#snippet children()}
                {#each items as deployment (deployment.id)}
                    <TableRow class="group cursor-pointer" onclick={() => goto(deploymentHref(deployment))}>
                        <TableCell>
                            <Badge variant={statusVariant(deployment.status)}>
                                {statusLabel(deployment.status)}
                            </Badge>
                        </TableCell>
                        <TableCell>
                            <a
                                href={deploymentHref(deployment)}
                                onclick={(event) => event.stopPropagation()}
                                class="font-medium hover:underline"
                            >
                                {deployment.name}
                            </a>
                        </TableCell>
                        <TableCell>
                            <a
                                href={`/clusters/${deployment.clusterId}`}
                                onclick={(event) => event.stopPropagation()}
                                class="hover:underline"
                            >
                                {deployment.clusterName}
                            </a>
                        </TableCell>
                        {#if !resourceId}
                        <TableCell class="hidden md:table-cell">
                            {#if deployment.projectId}
                                <a
                                    href={`/projects/${deployment.projectId}`}
                                    onclick={(event) => event.stopPropagation()}
                                    class="hover:underline"
                                >
                                    {deployment.projectName ?? "Project"}
                                </a>
                            {:else}
                                <span class="text-sm text-muted-foreground">—</span>
                            {/if}
                        </TableCell>
                        <TableCell class="hidden md:table-cell">
                            {#if deployment.resourceId}
                                {#if deployment.projectId}
                                    <a
                                        href={`/projects/${deployment.projectId}/${deployment.resourceId}`}
                                        onclick={(event) => event.stopPropagation()}
                                        class="hover:underline"
                                    >
                                        {deployment.resourceName ?? "Resource"}
                                    </a>
                                {:else}
                                    <span class="text-sm">
                                        {deployment.resourceName ?? "Resource"}
                                    </span>
                                {/if}
                            {:else}
                                <span class="text-sm text-muted-foreground">—</span>
                            {/if}
                        </TableCell>
                        {/if}
                        <TableCell class="hidden md:table-cell">
                            <span class="text-sm text-muted-foreground">
                                {new Date(deployment.createdAt).toLocaleString()}
                            </span>
                        </TableCell>
                        <TableCell class="text-right">
                            <span class="text-sm text-muted-foreground">
                                {formatDuration(deployment)}
                            </span>
                        </TableCell>
                    </TableRow>
                {/each}
            {/snippet}
        </DataTable>
    {/if}
</div>
