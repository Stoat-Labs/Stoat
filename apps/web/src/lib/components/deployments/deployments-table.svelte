<script lang="ts">
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import DataPagination from "$lib/components/ui/data-table/data-pagination.svelte";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        streamErrorToast,
        subscribeToStream,
    } from "$lib/deployments/stream";
    import { deploymentStatusLabel } from "$lib/deployments/status";
    import { ago, deploymentDuration } from "$lib/format";
    import { imageIcon } from "$lib/resources/image-icons";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import Ellipsis from "phosphor-svelte/lib/DotsThreeIcon";
    import Trash2 from "phosphor-svelte/lib/TrashIcon";
    import ArrowRight from "phosphor-svelte/lib/ArrowRightIcon";
    import Box from "phosphor-svelte/lib/CubeIcon";
    import GitCommit from "phosphor-svelte/lib/GitCommitIcon";
    import Server from "phosphor-svelte/lib/HardDrivesIcon";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import {
        listPageSize,
        pageParser,
    } from "$lib/params/query-params";
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
        latest,
        onDeploymentChange,
    }: {
        /** Show the newest N deployments (1–100) with live updates, without pagination. */
        latest?: number;
        onDeploymentChange?: () => void;
    } = $props();

    // Rows that fit the viewport, so the list fills the page without scrolling.
    // 45px per row; the rest is the page header, pagination and padding.
    const rowHeight = 45;

    const pageChrome = 200;

    let viewportHeight = $state(900);

    const pageSize = $derived(
        Math.min(
            listPageSize,
            Math.max(
                5,
                Math.floor((viewportHeight - pageChrome) / rowHeight),
            ),
        ),
    );

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

    const watchToast = streamErrorToast();

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

    useHeaderActions(statusFilters, () => latest === undefined);

    onMount(() => {
        let stopped = false;
        const clock = setInterval(() => (now = Date.now()), 30_000);
        const queryKey = orpc.cluster.listAllDeployments.key();

        const stop = subscribeToStream(
            (signal) =>
                watchToast.connected(
                    client.cluster.watchDeployments(undefined, {
                        signal,
                    }),
                ),
            () => {
                watchToast.clear();
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
            (error, reconnecting) =>
                watchToast.show(error, reconnecting),
        );

        return () => {
            stopped = true;
            clearInterval(clock);
            stop();
            watchToast.clear();
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
            ? total
                ? `Latest ${items.length} of ${total}`
                : undefined
            : total === 0
              ? "0 of 0"
              : `${(currentPage - 1) * limit + 1}–${Math.min(currentPage * limit, total)} of ${total}`,
    );

    type DeploymentRow = Pick<
        (typeof items)[number],
        | "id"
        | "status"
        | "name"
        | "metadata"
        | "images"
        | "clusterId"
        | "clusterName"
        | "projectName"
        | "resourceName"
        | "resourceIcon"
        | "createdAt"
        | "finishedAt"
    >;

    // Stand-in values that give the skeleton a real row's shape.
    const placeholderDeployment: DeploymentRow = {
        id: "placeholder",
        status: "ready",
        name: "deployment-name",
        metadata: null,
        images: { app: "ghcr.io/example/app:latest" },
        clusterId: "placeholder",
        clusterName: "cluster",
        projectName: "Project",
        resourceName: "resource",
        resourceIcon: null,
        createdAt: new Date(),
        finishedAt: new Date(),
    };

    const placeholderRows = $derived(
        Array.from({ length: limit }, (_, index) => index),
    );

    const jobLabels = new Map([
        ["InitializeCluster", "Cluster setup"],
        ["DeployCaddy", "Caddy"],
        ["ProvisionCluster", "Cluster creation"],
        ["AddMachine", "New machine"],
    ]);

    const sources = {
        forgejo: "Forgejo",
        github: "GitHub",
        git: "Git",
        docker: "Docker",
    };

    const dots = new Map([
        ["queued", "bg-warning"],
        ["running", "bg-info animate-pulse"],
        ["ready", "bg-success"],
        ["failed", "bg-destructive"],
    ]);

    function label(deployment: DeploymentRow) {
        if (!deployment.resourceName)
            return jobLabels.get(deployment.name) ?? deployment.name;

        return deployment.projectName
            ? `${deployment.projectName} / ${deployment.resourceName}`
            : deployment.resourceName;
    }

    // What shipped: a Git deploy's commit message, a Docker deploy's image.
    function shipped(deployment: DeploymentRow) {
        const message =
            deployment.metadata?.commit?.message.split("\n")[0];

        if (message) return message;

        const [first, ...rest] = Object.values(deployment.images);

        if (!first) return undefined;

        return rest.length ? `${first} + ${rest.length} more` : first;
    }

    function logo(deployment: DeploymentRow) {
        return (
            deployment.resourceIcon ??
            imageIcon(Object.values(deployment.images)[0])
        );
    }

    function isSettled(status: string) {
        return (
            status === "ready" ||
            status === "failed" ||
            status === "cancelled"
        );
    }

    function setStatus(value: string) {
        const filter = filters.find((item) => item.value === value);

        if (filter && list.status.current !== filter.value)
            void list.set(
                { status: filter.value, page: 1 },
                { history: "push" },
            );
    }
</script>

<svelte:window bind:innerHeight={viewportHeight} />

{#snippet statusFilters()}
    <!-- Six buttons crowd a phone header, so small screens get one select. -->
    <Select
        items={filters}
        bind:value={() => list.status.current, setStatus}
    >
        <SelectTrigger
            aria-label="Filter by status"
            class="w-36 sm:hidden"
        >
            <SelectValue />
        </SelectTrigger>
        <SelectContent>
            {#each filters as filter (filter.value)}<SelectItem
                    value={filter.value}
                    label={filter.label}
                >
                    {filter.label}
                </SelectItem>{/each}
        </SelectContent>
    </Select>
    <div
        class="hidden max-w-full flex-wrap items-center gap-2 sm:flex"
        role="group"
        aria-label="Filter by status"
    >
        {#each filters as filter (filter.value)}
            <Button
                size="sm"
                variant={list.status.current === filter.value
                    ? "default"
                    : "outline"}
                onclick={() => setStatus(filter.value)}
            >
                {filter.label}
            </Button>
        {/each}
    </div>
{/snippet}

<div
    class={latest === undefined
        ? "mx-auto w-full max-w-[96rem] space-y-4 pt-6"
        : "w-full space-y-3"}
>
    {#if latest !== undefined}
        <div class="flex items-center justify-between gap-2">
            <h2 class="flex min-w-0 items-baseline gap-2">
                <span class="truncate font-medium">
                    Recent deployments
                </span>
                {#if meta}
                    <span
                        class="shrink-0 text-xs text-muted-foreground tabular-nums"
                    >
                        {meta}
                    </span>
                {/if}
            </h2>
            <Button size="sm" variant="ghost" href="/deployments">
                View all deployments <ArrowRight
                    class="size-4"
                    aria-hidden="true"
                />
            </Button>
        </div>
    {/if}

    {#if deploymentsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load deployments: {deploymentsQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if deploymentsQuery.isPending}
        <Skeleton loading label="Loading deployments">
            <ul class="divide-y rounded-xl border bg-card">
                {#each placeholderRows as row (row)}
                    {@render deploymentRow(placeholderDeployment)}
                {/each}
            </ul>
        </Skeleton>
    {:else if items.length === 0}
        <Empty class="rounded-xl border py-10 md:py-10">
            <EmptyHeader>
                <EmptyTitle class="text-base">
                    {status === "all"
                        ? "No deployments yet"
                        : `No ${status} deployments`}
                </EmptyTitle>
                <EmptyDescription>
                    {status === "all"
                        ? "Deploy a resource or initialize cluster monitoring to create the first deployment."
                        : "No deployments currently match this filter."}
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <ul class="divide-y rounded-xl border bg-card">
            {#each items as deployment (deployment.id)}
                {@render deploymentRow(deployment)}
            {/each}
        </ul>
    {/if}

    {#if latest === undefined && total > 0}
        <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted-foreground tabular-nums">
                {meta}
            </span>
            {#if totalPages > 1}
                <DataPagination
                    bind:page={
                        () => list.page.current,
                        (page) => {
                            void list.set(
                                { page },
                                { history: "push" },
                            );
                        }
                    }
                    {totalPages}
                />
            {/if}
        </div>
    {/if}
</div>

{#snippet deploymentRow(deployment: DeploymentRow)}
    {@const icon = logo(deployment)}
    {@const commit = deployment.metadata?.commit}
    {@const what = shipped(deployment)}
    <li
        class="relative grid h-11 grid-cols-[minmax(0,1fr)_9rem_8rem] items-center gap-x-4 px-3 text-sm transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent/50 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_9rem_8rem] lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_9rem_7rem_8rem_8rem]"
    >
        <div class="flex min-w-0 items-center gap-2.5">
            {#if !deployment.resourceName}
                <Server
                    class="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
            {:else if icon}
                <img
                    src={icon}
                    alt=""
                    aria-hidden="true"
                    class="size-4 shrink-0 object-contain"
                />
            {:else}
                <Box
                    class="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                />
            {/if}
            <!-- Its hit area stretches over the whole row, so clicking anywhere opens the deployment. -->
            <a
                href={`/deployments/${deployment.id}`}
                class="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
                {label(deployment)}
            </a>
        </div>

        <span class="hidden truncate md:block" title={what}>
            {what}
        </span>

        <span class="flex items-center gap-2 whitespace-nowrap">
            <span
                class={[
                    "size-2 shrink-0 rounded-full",
                    dots.get(deployment.status) ??
                        "bg-muted-foreground",
                ]}
                aria-hidden="true"
            ></span>
            {deploymentStatusLabel(deployment.status)}
            <span class="text-muted-foreground tabular-nums">
                {deploymentDuration(
                    deployment.createdAt,
                    deployment.finishedAt,
                    now,
                )}
            </span>
        </span>

        <span
            class="hidden min-w-0 items-center gap-1.5 text-muted-foreground lg:flex"
        >
            {#if commit}
                <GitCommit
                    class="size-4 shrink-0"
                    aria-hidden="true"
                />
                <span class="truncate font-mono text-xs">
                    {commit.sha.slice(0, 7)}
                </span>
            {:else if deployment.metadata}
                <span class="truncate">
                    via {sources[deployment.metadata.source]}
                </span>
            {/if}
        </span>

        <a
            href={`/clusters/${deployment.clusterId}`}
            class="relative z-10 hidden min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline lg:flex"
        >
            <Server class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{deployment.clusterName}</span>
        </a>

        <span class="flex items-center justify-end gap-1">
            <span
                class="whitespace-nowrap text-muted-foreground"
                title={new Date(
                    deployment.createdAt,
                ).toLocaleString()}
            >
                {ago(deployment.createdAt, now)}
            </span>
            <span class="relative z-10 size-7">
                {#if isSettled(deployment.status) && deployment.id !== "placeholder"}
                    <Menu>
                        <MenuTrigger
                            aria-label="Deployment actions"
                            class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Ellipsis
                                class="size-4"
                                aria-hidden="true"
                            />
                        </MenuTrigger>
                        <MenuPopup align="end">
                            <MenuItem
                                variant="destructive"
                                onclick={() =>
                                    void list.set({
                                        deleteId: deployment.id,
                                    })}
                            >
                                <Trash2 aria-hidden="true" />
                                Delete
                            </MenuItem>
                        </MenuPopup>
                    </Menu>
                {/if}
            </span>
        </span>
    </li>
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
