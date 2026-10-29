<script lang="ts">
    import { goto } from "$app/navigation";
    import ClusterHealthBadge from "$lib/components/clusters/cluster-health-badge.svelte";
    import CreateClusterDialog from "$lib/components/clusters/create-cluster-dialog.svelte";
    import ProvisionClusterDialog from "$lib/components/clusters/provision-cluster-dialog.svelte";
    import ProvisionStatusBadge from "$lib/components/clusters/provision-status-badge.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        AlertDialog,
        AlertDialogContent,
        AlertDialogDescription,
        AlertDialogFooter,
        AlertDialogHeader,
        AlertDialogTitle,
    } from "$lib/components/ui/alert-dialog";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import { DataTable } from "$lib/components/ui/data-table";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import {
        TableCell,
        TableHead,
        TableRow,
    } from "$lib/components/ui/table";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { formatDate } from "$lib/format";
    import {
        listPageSize,
        pageParser,
    } from "$lib/params/query-params";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Plus from "@lucide/svelte/icons/plus";
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import Search from "@lucide/svelte/icons/search";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { Debounced } from "runed";
    import { onMount } from "svelte";

    const limit = listPageSize;

    const list = useQueryStates(
        {
            q: parseAsString.withDefault(""),
            page: pageParser,
            dialog: parseAsString,
            clusterId: parseAsString,
            source: parseAsStringLiteral([
                "connect",
                "server",
            ]).withDefault("connect"),
        },
        { shallow: true, scroll: false },
    );

    const debounced = new Debounced(() => list.q.current, 400);

    const searchPending = $derived(
        list.q.current !== debounced.current,
    );

    let ready = $state(false);

    useHeaderActions(clusterActions);

    onMount(() => {
        ready = true;

        return () => {
            ready = false;
        };
    });

    const clustersQuery = createQuery(() =>
        orpc.cluster.listClusters.queryOptions({
            input: {
                q: debounced.current || undefined,
                limit,
                offset: (list.page.current - 1) * limit,
                includeDiagnostics: false,
            },
            enabled: !searchPending,
            // Setups also finish while their dialog is closed.
            refetchInterval: (query) =>
                query.state.data?.items.some(
                    (cluster) =>
                        cluster.setup?.status === "queued" ||
                        cluster.setup?.status === "running",
                )
                    ? 3000
                    : false,
        }),
    );

    const items = $derived(clustersQuery.data?.items ?? []);

    const canManage = $derived(
        clustersQuery.data?.canManage === true,
    );

    const total = $derived(clustersQuery.data?.total ?? 0);

    const totalPages = $derived(
        Math.max(1, Math.ceil(total / limit)),
    );

    // ponytail: no auto-clamp when total shrinks; pagination UI already
    // gets totalPages, re-add URL write-back if empty last-pages get reported.

    const meta = $derived(
        total === 0
            ? "0 of 0"
            : `${(list.page.current - 1) * limit + 1}–${Math.min(list.page.current * limit, total)} of ${total}`,
    );

    type ClusterItem = (typeof items)[number];

    const clusterToDelete = $derived(
        items.find(
            (cluster) => cluster.id === list.clusterId.current,
        ) ?? null,
    );

    const deleteOpen = $derived(
        list.dialog.current === "delete-cluster" &&
            Boolean(clusterToDelete),
    );

    const deleteMutationState = createMutation(() =>
        orpc.cluster.deleteCluster.mutationOptions({
            onSuccess: async () => {
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey:
                            orpc.cluster.listClusters.queryKey(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.projects.key(),
                    }),
                ]);
                void list.set({ dialog: null, clusterId: null });
            },
        }),
    );

    const deleteErrorMessage = $derived(
        deleteMutationState.error
            ? deleteMutationState.error.message ||
                  "Unable to delete cluster."
            : "",
    );

    const deleteName = $derived(
        clusterToDelete?.name ?? "this cluster",
    );

    const deleteProjectCount = $derived(
        clusterToDelete?.projectCount ?? 0,
    );

    const deleteProjectCopy = $derived(
        deleteProjectCount === 1
            ? "Its 1 project will also be removed."
            : `Its ${deleteProjectCount} projects will also be removed.`,
    );

    function askDelete(cluster: ClusterItem) {
        deleteMutationState.reset();
        void list.set({
            dialog: "delete-cluster",
            clusterId: cluster.id,
        });
    }

    // Clusters still being set up open their provisioning dialog instead.
    function openCluster(cluster: ClusterItem) {
        if (cluster.setup)
            void list.set({
                dialog: "provision",
                clusterId: cluster.id,
            });
        else void goto(`/clusters/${cluster.id}`);
    }

    function confirmDelete() {
        if (!clusterToDelete || deleteMutationState.isPending) return;
        deleteMutationState.mutate({ clusterId: clusterToDelete.id });
    }
</script>

<svelte:head><title>Clusters / Stoat</title></svelte:head>

{#snippet clusterActions()}
    <div
        class="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2"
    >
        <InputGroup class="w-40 sm:w-64">
            <InputGroupInput
                type="search"
                placeholder="Search clusters…"
                aria-label="Search clusters"
                bind:value={
                    () => list.q.current,
                    (q) => {
                        void list.set({ q, page: 1 });
                    }
                }
            />
            <InputGroupAddon align="inline-start">
                <Search aria-hidden="true" />
            </InputGroupAddon>
        </InputGroup>
        {#if canManage}
            <Menu>
                <MenuTrigger
                    class={buttonVariants({ size: "sm" })}
                    disabled={!ready}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    Create cluster
                    <ChevronDown
                        class="size-3.5"
                        aria-hidden="true"
                    />
                </MenuTrigger>
                <MenuPopup align="end" class="min-w-44">
                    <MenuItem
                        onclick={() =>
                            void list.set({
                                dialog: "create-cluster",
                                source: "connect",
                            })}
                    >
                        Connect existing
                    </MenuItem>
                    <MenuItem
                        onclick={() =>
                            void list.set({
                                dialog: "create-cluster",
                                source: "server",
                            })}
                    >
                        New server
                    </MenuItem>
                </MenuPopup>
            </Menu>
        {/if}
    </div>
{/snippet}

<div class="w-full space-y-6 pt-6">
    {#if clustersQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load clusters: {clustersQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <DataTable
            title="Clusters"
            {meta}
            loading={clustersQuery.isPending || searchPending}
            loadingRows={5}
            colSpan={4}
            isEmpty={items.length === 0}
            emptyTitle={debounced.current
                ? "No matching clusters"
                : "No clusters yet"}
            emptyDescription={debounced.current
                ? "No clusters match your search."
                : "Create your first cluster to get started."}
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
                    <TableHead class="w-px">Status</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead class="text-right">Projects</TableHead>
                    <TableHead class="w-10">
                        <span class="sr-only">Actions</span>
                    </TableHead>
                </TableRow>
            {/snippet}
            {#snippet children()}
                {#each items as cluster (cluster.id)}
                    <TableRow
                        class="group cursor-pointer"
                        onclick={() => openCluster(cluster)}
                    >
                        <TableCell class="w-px">
                            {#if cluster.setup}
                                <ProvisionStatusBadge
                                    status={cluster.setup.status}
                                />
                            {:else}
                                <ClusterHealthBadge
                                    clusterId={cluster.id}
                                />
                            {/if}
                        </TableCell>
                        <TableCell>
                            {#if cluster.setup?.deploymentId}
                                <a
                                    href={`/deployments/${cluster.setup.deploymentId}`}
                                    class="block font-semibold hover:underline"
                                >
                                    {cluster.name}
                                </a>
                                <span
                                    class="mt-0.5 block text-xs text-muted-foreground"
                                >
                                    {cluster.setup.host}
                                </span>
                            {:else if cluster.setup}
                                <button
                                    type="button"
                                    class="block font-semibold hover:underline"
                                    onclick={(event) => {
                                        event.stopPropagation();
                                        openCluster(cluster);
                                    }}
                                >
                                    {cluster.name}
                                </button>
                                <span
                                    class="mt-0.5 block text-xs text-muted-foreground"
                                >
                                    {cluster.setup.host}
                                </span>
                            {:else}
                                <a
                                    href={`/clusters/${cluster.id}`}
                                    onclick={(event) =>
                                        event.stopPropagation()}
                                    class="block font-semibold hover:underline"
                                >
                                    {cluster.name}
                                </a>
                                <span
                                    class="mt-0.5 block text-xs text-muted-foreground"
                                >
                                    Created {formatDate(
                                        cluster.createdAt,
                                    )}
                                </span>
                            {/if}
                        </TableCell>
                        <TableCell class="text-right tabular-nums">
                            {cluster.projectCount}
                        </TableCell>
                        <TableCell class="w-10 text-right">
                            {#if canManage}
                                <Menu>
                                    <MenuTrigger
                                        aria-label={`Actions for ${cluster.name}`}
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
                                                askDelete(cluster);
                                            }}
                                        >
                                            <Trash2
                                                aria-hidden="true"
                                            />
                                            Delete
                                        </MenuItem>
                                    </MenuPopup>
                                </Menu>
                            {/if}
                        </TableCell>
                    </TableRow>
                {/each}
            {/snippet}
            {#snippet emptyAction()}
                {#if canManage}
                    <Button
                        size="sm"
                        disabled={!ready}
                        onclick={() =>
                            void list.set({
                                dialog: "create-cluster",
                            })}
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        New cluster
                    </Button>
                {/if}
            {/snippet}
        </DataTable>
    {/if}
</div>

<CreateClusterDialog
    bind:open={
        () => list.dialog.current === "create-cluster",
        (open) => {
            if (
                ready &&
                !open &&
                list.dialog.current === "create-cluster"
            )
                void list.set({ dialog: null, source: null });
        }
    }
    source={list.source.current}
    onprovision={(clusterId) =>
        void list.set({
            dialog: "provision",
            clusterId,
            source: null,
        })}
/>

<ProvisionClusterDialog />

<AlertDialog
    bind:open={
        () => deleteOpen,
        (open) => {
            if (!open)
                void list.set({ dialog: null, clusterId: null });
        }
    }
>
    <AlertDialogContent>
        <AlertDialogHeader>
            <AlertDialogTitle>Delete cluster?</AlertDialogTitle>
            <AlertDialogDescription class="break-words">
                "{deleteName}" will be permanently deleted. {deleteProjectCopy}
                This action cannot be undone.
            </AlertDialogDescription>
        </AlertDialogHeader>
        {#if deleteErrorMessage}
            <div class="px-6">
                <Alert variant="error">
                    <AlertDescription>
                        {deleteErrorMessage}
                    </AlertDescription>
                </Alert>
            </div>
        {/if}
        <AlertDialogFooter>
            <Button
                variant="outline"
                disabled={deleteMutationState.isPending}
                onclick={() => {
                    void list.set({ dialog: null, clusterId: null });
                }}
            >
                Cancel
            </Button>
            <Button
                variant="destructive"
                loading={deleteMutationState.isPending}
                disabled={deleteMutationState.isPending ||
                    !clusterToDelete}
                onclick={confirmDelete}
            >
                Delete
            </Button>
        </AlertDialogFooter>
    </AlertDialogContent>
</AlertDialog>
