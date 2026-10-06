<script lang="ts">
    import { goto } from "$app/navigation";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { DataTable } from "$lib/components/ui/data-table";
    import {
        TableCell,
        TableHead,
        TableRow,
    } from "$lib/components/ui/table";
    import { subscribeToStream } from "$lib/deployment-stream";
    import {
        deploymentStatusLabel,
        deploymentStatusVariant,
    } from "$lib/deployment-status";
    import { ago, deploymentDuration } from "$lib/format";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { listPageSize, pageParser } from "$lib/query-params";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { onMount } from "svelte";

    let {
        resourceId,
        latest,
        onDeploymentChange,
    }: {
        resourceId?: string;
        /** Show the newest N deployments (1–100) with live updates, without pagination. */
        latest?: number;
        onDeploymentChange?: () => void;
    } = $props();

    // The paginated view sizes its page to the viewport so the whole table
    // fits without scrolling. The first fit is measured on the skeleton rows,
    // and the query waits for it.
    let container = $state<HTMLDivElement>();

    let viewportHeight = $state(0);

    let fittedRows = $state<number>();

    const limit = $derived(
        latest === undefined
            ? (fittedRows ?? listPageSize)
            : Math.min(100, Math.max(1, Math.floor(latest))),
    );

    let now = $state(Date.now());

    type StatusFilter =
        | "all"
        | "queued"
        | "running"
        | "ready"
        | "failed"
        | "cancelled";

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
            status: parseAsStringLiteral(
                filters.map((filter) => filter.value),
            ).withDefault("all"),
            page: pageParser,
        },
        { shallow: true, scroll: false },
    );

    const status = $derived(
        latest === undefined ? list.status.current : "all",
    );

    const currentPage = $derived(
        latest === undefined ? list.page.current : 1,
    );

    // Finished deployments are immutable: terminal filters stay cached until a
    // watch event invalidates them, so back-nav never refetches. Live filters
    // keep the 15s app default. placeholderData keeps the previous page visible.
    const isTerminalFilter = $derived(
        status === "ready" ||
            status === "failed" ||
            status === "cancelled",
    );

    const deploymentsQuery = createQuery(() => {
        const input = {
            status: status === "all" ? undefined : status,
            limit,
            offset: (currentPage - 1) * limit,
            resourceId,
        };

        // Wait for the viewport fit so the first fetch already has the right size.
        const enabled =
            latest !== undefined || fittedRows !== undefined;

        if (isTerminalFilter)
            return orpc.cluster.listAllDeployments.queryOptions({
                input,
                enabled,
                staleTime: Infinity,
                gcTime: 30 * 60_000,
                placeholderData: (previous) => previous,
            });

        return orpc.cluster.listAllDeployments.queryOptions({
            input,
            enabled,
            placeholderData: (previous) => previous,
        });
    });

    // Pagination footer (p-2 + h-8 buttons + border) and the wrapper's pb-6
    // plus the app shell's pb-6 sit below the rows.
    const belowRows = 49 + 24 + 24;

    $effect(() => {
        if (
            latest !== undefined ||
            !container ||
            viewportHeight === 0
        )
            return;

        const body = container.querySelector<HTMLTableSectionElement>(
            "[data-slot=table-body]",
        );

        if (!body) return;

        // Skeleton rows share the real row markup, so both measure the same.
        // The empty state is a single tall row and says nothing about rows.
        if (!deploymentsQuery.isPending && items.length === 0) return;

        const rowHeight = body.offsetHeight / body.rows.length;

        const available =
            viewportHeight -
            (body.getBoundingClientRect().top + window.scrollY) -
            belowRows;

        fittedRows = Math.min(
            100,
            Math.max(5, Math.floor(available / rowHeight)),
        );
    });

    let watchError = $state("");

    useHeaderActions(statusFilters, () => latest === undefined);

    onMount(() => {
        let stopped = false;
        const clock = setInterval(() => (now = Date.now()), 30_000);
        const queryKey = orpc.cluster.listAllDeployments.key();

        const stop = subscribeToStream(
            (signal) =>
                client.cluster.watchDeployments(undefined, {
                    signal,
                }),
            () => {
                watchError = "";
                onDeploymentChange?.();

                // Cancel even the initial fetch: it may predate subscription readiness.
                void queryClient
                    .cancelQueries({ queryKey })
                    .then(() => {
                        if (!stopped)
                            void queryClient.invalidateQueries({
                                queryKey,
                            });
                    });
            },
            (error, reconnecting) => {
                watchError = `${error instanceof Error ? error.message : "Live updates unavailable."}${reconnecting ? " Reconnecting..." : " Reload the page to reconnect."}`;
            },
        );

        return () => {
            stopped = true;
            clearInterval(clock);
            stop();
        };
    });

    const items = $derived(
        latest === undefined
            ? (deploymentsQuery.data?.items ?? [])
            : (deploymentsQuery.data?.items ?? []).slice(0, limit),
    );

    const total = $derived(deploymentsQuery.data?.total ?? 0);

    const totalPages = $derived(
        latest === undefined
            ? Math.max(1, Math.ceil(total / limit))
            : 1,
    );

    // ponytail: no auto-clamp when total shrinks; pagination UI already
    // gets totalPages, re-add URL write-back if empty last-pages get reported.

    const meta = $derived(
        latest !== undefined
            ? `${items.length} most recent`
            : total === 0
              ? "0 of 0"
              : `${(currentPage - 1) * limit + 1}–${Math.min(currentPage * limit, total)} of ${total}`,
    );

    type DeploymentRow = Pick<
        (typeof items)[number],
        | "id"
        | "status"
        | "name"
        | "clusterId"
        | "clusterName"
        | "projectId"
        | "projectName"
        | "resourceId"
        | "resourceName"
        | "createdAt"
        | "finishedAt"
    >;

    // Stand-in values that give the Phantom UI skeleton a real row's shape.
    const placeholderDeployment: DeploymentRow = {
        id: "placeholder",
        status: "ready",
        name: "deployment-name",
        clusterId: "placeholder",
        clusterName: "cluster",
        projectId: "placeholder",
        projectName: "Project name",
        resourceId: "placeholder",
        resourceName: "resource",
        createdAt: new Date(),
        finishedAt: new Date(),
    };

    function deploymentHref(deployment: {
        id: string;
        projectId: string | null;
    }) {
        return resourceId && deployment.projectId
            ? `/projects/${deployment.projectId}/${resourceId}/deployments/${deployment.id}`
            : `/deployments/${deployment.id}`;
    }
</script>

{#snippet statusFilters()}
    <div
        class="flex max-w-full flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter by status"
    >
        {#each filters as filter (filter.value)}
            <Button
                size="sm"
                variant={list.status.current === filter.value
                    ? "default"
                    : "outline"}
                onclick={() => {
                    if (list.status.current !== filter.value) {
                        void list.set(
                            { status: filter.value, page: 1 },
                            { history: "push" },
                        );
                    }
                }}
            >
                {filter.label}
            </Button>
        {/each}
    </div>
{/snippet}

<svelte:window bind:innerHeight={viewportHeight} />

<div
    bind:this={container}
    class={latest === undefined
        ? "w-full space-y-6 pt-6"
        : "w-full space-y-3"}
>
    {#if watchError}
        <Alert variant="warning">
            <AlertDescription>{watchError}</AlertDescription>
        </Alert>
    {/if}

    {#if deploymentsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load deployments: {deploymentsQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else}
        <DataTable
            title={latest === undefined
                ? "Deployments"
                : "Recent deployments"}
            {meta}
            loading={deploymentsQuery.isPending}
            loadingRows={limit}
            colSpan={resourceId || latest !== undefined ? 5 : 7}
            isEmpty={items.length === 0}
            emptyTitle={status === "all"
                ? "No deployments yet"
                : `No ${status} deployments`}
            emptyDescription={status === "all"
                ? resourceId
                    ? "Deploy this resource to create its first deployment."
                    : "Deploy a resource or initialize cluster monitoring to create the first deployment."
                : "No deployments currently match this filter."}
            bind:page={
                () => list.page.current,
                (page) => {
                    void list.set({ page }, { history: "push" });
                }
            }
            {totalPages}
        >
            {#snippet header()}
                <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Deployment</TableHead>
                    <TableHead>Cluster</TableHead>
                    {#if !resourceId && latest === undefined}
                        <TableHead class="hidden md:table-cell">
                            Project
                        </TableHead>
                        <TableHead class="hidden md:table-cell">
                            Resource
                        </TableHead>
                    {/if}
                    <TableHead class="hidden md:table-cell">
                        Created
                    </TableHead>
                    <TableHead class="text-right">Duration</TableHead>
                </TableRow>
            {/snippet}
            {#snippet placeholderRow()}
                {@render deploymentRow(placeholderDeployment)}
            {/snippet}
            {#snippet children()}
                {#each items as deployment (deployment.id)}
                    {@render deploymentRow(deployment)}
                {/each}
            {/snippet}
        </DataTable>
        {#if latest !== undefined && !resourceId}
            <div class="flex justify-end">
                <Button size="sm" variant="ghost" href="/deployments">
                    View all deployments <ArrowRight
                        class="size-4"
                        aria-hidden="true"
                    />
                </Button>
            </div>
        {/if}
    {/if}
</div>

{#snippet deploymentRow(deployment: DeploymentRow)}
    <TableRow
        class="group cursor-pointer"
        onclick={() => goto(deploymentHref(deployment))}
    >
        <TableCell>
            <Badge
                variant={deploymentStatusVariant(deployment.status)}
            >
                {deploymentStatusLabel(deployment.status)}
            </Badge>
        </TableCell>
        <TableCell>
            <a
                href={deploymentHref(deployment)}
                onclick={(event) => event.stopPropagation()}
                class="font-medium hover:underline"
            >
                {latest !== undefined && deployment.resourceName
                    ? `${deployment.projectName ? `${deployment.projectName} / ` : ""}${deployment.resourceName}`
                    : deployment.name}
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
        {#if !resourceId && latest === undefined}
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
                    <span class="text-sm text-muted-foreground">
                        —
                    </span>
                {/if}
            </TableCell>
            <TableCell class="hidden md:table-cell">
                {#if deployment.resourceId}
                    {#if deployment.projectId}
                        <a
                            href={`/projects/${deployment.projectId}/${deployment.resourceId}`}
                            onclick={(event) =>
                                event.stopPropagation()}
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
                    <span class="text-sm text-muted-foreground">
                        —
                    </span>
                {/if}
            </TableCell>
        {/if}
        <TableCell class="hidden md:table-cell">
            <span class="text-sm text-muted-foreground">
                {latest === undefined
                    ? new Date(deployment.createdAt).toLocaleString()
                    : ago(deployment.createdAt, now)}
            </span>
        </TableCell>
        <TableCell class="text-right">
            <span class="text-sm text-muted-foreground">
                {deploymentDuration(
                    deployment.createdAt,
                    deployment.finishedAt,
                )}
            </span>
        </TableCell>
    </TableRow>
{/snippet}
