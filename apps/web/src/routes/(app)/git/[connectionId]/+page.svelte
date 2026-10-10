<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
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
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import { connectionDialogUrl } from "$lib/params/git-query-params";
    import { orpc, queryClient } from "$lib/api/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";

    const connectionId = $derived(page.params.connectionId ?? "");

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    const connection = $derived(
        connectionsQuery.data?.connections.find(
            (item) => item.id === connectionId,
        ),
    );

    const canManage = $derived(
        connectionsQuery.data?.canManage === true,
    );

    const repositoriesQuery = createQuery(() =>
        orpc.connections.getRepositories.queryOptions({
            input: { connectionId },
            enabled: Boolean(connection),
        }),
    );

    const repositories = $derived(
        repositoriesQuery.data?.repositories ?? [],
    );

    let deleteOpen = $state(false);

    const removeState = createMutation(() =>
        orpc.connections.delete.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.connections.list.queryKey(),
                });
                await goto("/git");
            },
        }),
    );

    const providerNames = {
        github: "GitHub",
        forgejo: "Forgejo",
        generic: "Generic Git server",
    };

    const authLabel = $derived(
        connection?.authType === "oauth"
            ? "OAuth"
            : connection?.hasCredentials
              ? "Token"
              : "No credentials",
    );

    const accountLabel = $derived(
        connection?.account
            ? `${connection.account.login}${connection.account.name ? ` (${connection.account.name})` : ""}`
            : "Account unavailable",
    );

    function edit() {
        void goto(
            connectionDialogUrl(
                new URL("/git", page.url),
                "edit-connection",
                connectionId,
            ),
        );
    }
</script>

<svelte:head>
    <title>{connection?.name ?? "Git connection"} / Stoat</title>
</svelte:head>

<div class="flex w-full min-w-0 flex-col gap-6 pt-6">
    <Button href="/git" variant="ghost" size="sm" class="-ml-2 w-fit">
        <ArrowLeft aria-hidden="true" />
        Git connections
    </Button>

    {#if connectionsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load connection: {connectionsQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if connectionsQuery.isPending}
        <Skeleton loading loading-label="Loading connection">
            <Frame>
                <FrameHeader>
                    <FrameTitle>Connection name</FrameTitle>
                </FrameHeader>
                <FramePanel class="h-40"></FramePanel>
            </Frame>
        </Skeleton>
    {:else if !connection}
        <Alert variant="error">
            <AlertDescription>
                This connection is unavailable. It may have been
                deleted or belong to another organization.
            </AlertDescription>
        </Alert>
    {:else}
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 items-center gap-3">
                <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted"
                >
                    <ProviderIcon provider={connection.provider} />
                </span>
                <div class="min-w-0">
                    <h1 class="truncate text-2xl font-semibold">
                        {connection.name}
                    </h1>
                    <p class="truncate text-sm text-muted-foreground">
                        {providerNames[connection.provider]}
                    </p>
                </div>
            </div>
            {#if canManage}
                <div class="flex gap-2">
                    <Button variant="outline" onclick={edit}>
                        Edit
                    </Button>
                    <Button
                        variant="destructive-outline"
                        onclick={() => (deleteOpen = true)}
                    >
                        Delete
                    </Button>
                </div>
            {/if}
        </div>

        <Frame>
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2>Details</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel>
                <dl class="grid min-w-0 gap-4 text-sm sm:grid-cols-3">
                    <div class="min-w-0">
                        <dt class="text-xs text-muted-foreground">
                            Server
                        </dt>
                        <dd class="break-all">
                            {connection.serverUrl}
                        </dd>
                    </div>
                    <div class="min-w-0">
                        <dt class="text-xs text-muted-foreground">
                            Account
                        </dt>
                        <dd class="break-all">{accountLabel}</dd>
                    </div>
                    <div>
                        <dt class="text-xs text-muted-foreground">
                            Authorization
                        </dt>
                        <dd>
                            <Badge variant="outline">
                                {authLabel}
                            </Badge>
                        </dd>
                    </div>
                </dl>
            </FramePanel>
        </Frame>

        <Frame class="min-w-0">
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2>Repositories</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel class="min-w-0 p-0">
                {#if repositoriesQuery.isError}
                    <div class="space-y-3 p-4">
                        <Alert variant="error">
                            <AlertDescription>
                                Unable to load repositories: {repositoriesQuery
                                    .error.message}
                            </AlertDescription>
                        </Alert>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={repositoriesQuery.isFetching}
                            onclick={() =>
                                repositoriesQuery.refetch()}
                        >
                            Retry
                        </Button>
                    </div>
                {:else}
                    <Skeleton
                        loading={repositoriesQuery.isPending}
                        loading-label="Loading repositories"
                    >
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Repository</TableHead>
                                    <TableHead class="text-center">
                                        Default branch
                                    </TableHead>
                                    <TableHead class="text-center">
                                        URL
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {#each repositoriesQuery.isPending ? [{ url: "placeholder", name: "owner/repository", defaultBranch: "main" }] : repositories as repo (repo.url)}
                                    <TableRow>
                                        <TableCell
                                            class="font-medium"
                                        >
                                            {repo.name}
                                        </TableCell>
                                        <TableCell
                                            class="text-center font-mono text-xs"
                                        >
                                            {repo.defaultBranch}
                                        </TableCell>
                                        <TableCell
                                            class="max-w-0 truncate text-center text-muted-foreground"
                                        >
                                            {repo.url}
                                        </TableCell>
                                    </TableRow>
                                {:else}
                                    <TableRow>
                                        <TableCell
                                            colspan={3}
                                            class="text-center text-muted-foreground"
                                        >
                                            {connection.provider ===
                                            "generic"
                                                ? "No repositories. Edit the connection to add known repository URLs."
                                                : "No repositories available to this account."}
                                        </TableCell>
                                    </TableRow>
                                {/each}
                            </TableBody>
                        </Table>
                        {#if repositoriesQuery.data?.truncated}
                            <p
                                class="border-t border-border p-3 text-xs text-muted-foreground"
                            >
                                Partial list returned by the provider;
                                not all repositories may be shown.
                            </p>
                        {/if}
                    </Skeleton>
                {/if}
            </FramePanel>
        </Frame>

        <ConfirmDialog
            bind:open={deleteOpen}
            title={`Delete "${connection.name}"?`}
            description="Deletion is blocked while any resource is attached. Detach those resources first."
            confirmLabel="Delete"
            pending={removeState.isPending}
            error={removeState.error?.message ?? ""}
            onconfirm={() => removeState.mutate({ connectionId })}
        />
    {/if}
</div>
