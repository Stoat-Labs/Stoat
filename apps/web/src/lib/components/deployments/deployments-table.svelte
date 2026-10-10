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
    import { subscribeToStream } from "$lib/deployments/stream";
    import {
        deploymentStatusLabel,
        deploymentStatusVariant,
    } from "$lib/deployments/status";
    import { ago, deploymentDuration } from "$lib/format";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { pageParser } from "$lib/params/query-params";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
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

    const pageSize = 15;

    const limit = $derived(
        latest === undefined
            ? pageSize
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
            deleteId: parseAsString,
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
    // keep the 15s app default.
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

        if (isTerminalFilter)
            return orpc.cluster.listAllDeployments.queryOptions({
                input,
                staleTime: Infinity,
                gcTime: 30 * 60_000,
            });

        return orpc.cluster.listAllDeployments.queryOptions({
            input,
        });
    });

    let watchError = $state("");

    const deleteMutation = createMutation(() =>
        orpc.cluster.deleteDeployment.mutationOptions({
            onSuccess: async (_data, input) => {
                queryClient.removeQueries({
                    queryKey: orpc.cluster.getDeployment.queryKey({
                        input: { deploymentId: input.deploymentId },
                    }),
                });
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                });
                await list.set({ deleteId: null });
                deleteMutation.reset();
            },
        }),
    );

    const canDelete = $derived(
        deploymentsQuery.data?.canDelete === true,
    );

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

    function isSettled(status: string) {
        return (
            status === "ready" ||
            status === "failed" ||
            status === "cancelled"
        );
    }

    function deploymentHref(deployment: {
        id: string;
        projectId: string | null;
    }) {
        return resourceId && deployment.projectId
            ? `/projects/${deployment.projectId}/${resourceId}/deployments/${deployment.id}`
            : `/deployments/${deployment.id}`;
    }
</script>

colSpan={(resourceId || latest !== undefined ? 5 : 7) +
    (canDelete ? 1 : 0)}

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

<div
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
                    <TableHead class="text-center">Status</TableHead>
                    <TableHead>Deployment</TableHead>
                    <TableHead class="text-center">Cluster</TableHead>
                    {#if !resourceId && latest === undefined}
                        <TableHead
                            class="hidden text-center md:table-cell"
                        >
                            Project
                        </TableHead>
                        <TableHead
                            class="hidden text-center md:table-cell"
                        >
                            Resource
                        </TableHead>
                    {/if}
                    <TableHead
                        class="hidden text-center md:table-cell"
                    >
                        Created
                    </TableHead>
                    <TableHead class="text-center">
                        Duration
                    </TableHead>
                    {#if canDelete}<TableHead class="w-10" />{/if}
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
        <TableCell class="text-center">
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
        <TableCell class="text-center">
            <a
                href={`/clusters/${deployment.clusterId}`}
                onclick={(event) => event.stopPropagation()}
                class="hover:underline"
            >
                {deployment.clusterName}
            </a>
        </TableCell>
        {#if !resourceId && latest === undefined}
            <TableCell class="hidden text-center md:table-cell">
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
            <TableCell class="hidden text-center md:table-cell">
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
        <TableCell class="hidden text-center md:table-cell">
            <span class="text-sm text-muted-foreground">
                {latest === undefined
                    ? new Date(deployment.createdAt).toLocaleString()
                    : ago(deployment.createdAt, now)}
            </span>
        </TableCell>
        <TableCell class="text-center">
            <span class="text-sm text-muted-foreground">
                {deploymentDuration(
                    deployment.createdAt,
                    deployment.finishedAt,
                )}
            </span>
        </TableCell>
        {#if canDelete}
            <TableCell class="w-10 text-right">
                {#if isSettled(deployment.status) && deployment.id !== "placeholder"}
                    <Menu>
                        <MenuTrigger
                            aria-label="Deployment actions"
                            class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                            onclick={(event) =>
                                event.stopPropagation()}
                        >
                            <Ellipsis
                                class="size-4"
                                aria-hidden="true"
                            />
                        </MenuTrigger>
                        <MenuPopup align="end">
                            <MenuItem
                                variant="destructive"
                                onclick={(event) => {
                                    event.stopPropagation();
                                    void list.set({
                                        deleteId: deployment.id,
                                    });
                                }}
                            >
                                <Trash2 aria-hidden="true" />
                                Delete
                            </MenuItem>
                        </MenuPopup>
                    </Menu>
                {/if}
            </TableCell>
        {/if}
    </TableRow>
{/snippet}

<ConfirmDialog
    bind:open={
        () => list.deleteId.current !== null,
        (open) => {
            if (!open) {
                void list.set({ deleteId: null });
                deleteMutation.reset();
            }
        }
    }
    title="Delete deployment?"
    description="This permanently removes the deployment and its logs. Running services are not affected."
    confirmLabel="Delete deployment"
    pending={deleteMutation.isPending}
    error={deleteMutation.error?.message ?? ""}
    onconfirm={() => {
        const deploymentId = list.deleteId.current;

        if (deploymentId) deleteMutation.mutate({ deploymentId });
    }}
/>
