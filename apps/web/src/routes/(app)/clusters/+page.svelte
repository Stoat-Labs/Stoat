<script lang="ts">
    import CreateClusterDialog from "$lib/components/clusters/create-cluster-dialog.svelte";
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
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { DataTable } from "$lib/components/ui/data-table";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
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
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import Plus from "@lucide/svelte/icons/plus";
    import Search from "@lucide/svelte/icons/search";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { Debounced } from "runed";
    import { onMount } from "svelte";

    const limit = listPageSize;

    const list = useQueryStates(
        {
            q: parseAsString.withDefault(""),
            page: pageParser,
            dialog: parseAsString,
            clusterId: parseAsString,
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
            },
            enabled: !searchPending,
        }),
    );

    const items = $derived(clustersQuery.data?.items ?? []);

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

    type ClusterItem = {
        id: string;
        name: string;
        projectCount: number;
    };

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
        <Button
            size="sm"
            disabled={!ready}
            onclick={() =>
                void list.set({ dialog: "create-cluster" })}
        >
            <Plus class="size-4" aria-hidden="true" />
            Create cluster
        </Button>
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
            colSpan={5}
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
                    <TableHead>Status</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Projects</TableHead>
                    <TableHead class="hidden md:table-cell">
                        Updated
                    </TableHead>
                    <TableHead>
                        <span class="sr-only">Actions</span>
                    </TableHead>
                </TableRow>
            {/snippet}
            {#snippet children()}
                {#each items as cluster (cluster.id)}
                    <TableRow class="group">
                        <TableCell>
                            {#if cluster.diagnostics?.status === "healthy"}
                                <Badge variant="success">
                                    Healthy
                                </Badge>
                            {:else if cluster.diagnostics?.status === "degraded"}
                                <Badge variant="warning">
                                    Degraded
                                </Badge>
                            {:else}
                                <Badge variant="secondary">
                                    Unknown
                                </Badge>
                            {/if}
                        </TableCell>
                        <TableCell>
                            <a
                                href={`/clusters/${cluster.id}`}
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
                        </TableCell>
                        <TableCell>{cluster.projectCount}</TableCell>
                        <TableCell class="hidden md:table-cell">
                            {formatDate(cluster.updatedAt)}
                        </TableCell>
                        <TableCell>
                            <Menu>
                                <MenuTrigger
                                    class={buttonVariants({
                                        variant: "ghost",
                                        size: "icon-xs",
                                        class: "md:opacity-0 md:opacity-100 md:focus-visible:opacity-100",
                                    })}
                                    aria-label={`Actions for ${cluster.name}`}
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
                                            askDelete(cluster)}
                                    >
                                        <Trash2 aria-hidden="true" />
                                        Delete
                                    </MenuItem>
                                </MenuPopup>
                            </Menu>
                        </TableCell>
                    </TableRow>
                {/each}
            {/snippet}
            {#snippet emptyAction()}
                <Button
                    size="sm"
                    disabled={!ready}
                    onclick={() =>
                        void list.set({ dialog: "create-cluster" })}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    New cluster
                </Button>
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
                void list.set({ dialog: null });
        }
    }
/>

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
