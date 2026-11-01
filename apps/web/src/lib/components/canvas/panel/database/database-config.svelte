<script lang="ts">
    import { orpc, queryClient } from "$lib/api/orpc";
    import ConnectionField from "$lib/components/clusters/connection-field.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Input } from "$lib/components/ui/input";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import Layers from "@lucide/svelte/icons/layers";
    import Package from "@lucide/svelte/icons/package";
    import Plug from "@lucide/svelte/icons/plug";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import type { Component, Snippet } from "svelte";
    import {
        quoteIdent,
        sqlQuery,
        type DatabaseInput,
    } from "./query";

    let { input }: { input: DatabaseInput } = $props();

    const connection = createQuery(() =>
        orpc.resources.getConnection.queryOptions({ input }),
    );

    const credentials = $derived.by(() => {
        const internal = connection.data?.internal;

        if (!internal) return undefined;
        const url = new URL(internal);

        return {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
        };
    });

    // Older deploys named the role after the prefixed service instead of POSTGRES_USER.
    const role = createQuery(() =>
        sqlQuery(input, "SELECT current_user"),
    );

    const staleRole = $derived(
        credentials &&
            role.data?.rows[0]?.[0] !== credentials.username
            ? role.data?.rows[0]?.[0]
            : undefined,
    );

    let renaming = $state(false);

    const rename = createMutation(() =>
        orpc.resources.renamePostgresRole.mutationOptions({
            onSuccess: async () => {
                renaming = false;
                await role.refetch();
            },
        }),
    );

    const extensions = createQuery(() =>
        sqlQuery(
            input,
            `SELECT name, coalesce(installed_version, default_version), installed_version IS NOT NULL, comment
             FROM pg_available_extensions ORDER BY name`,
        ),
    );

    let search = $state("");

    const installed = $derived(
        extensions.data?.rows.filter((row) => row[2] === "t") ?? [],
    );

    const available = $derived(
        extensions.data?.rows.filter(
            (row) =>
                row[2] === "f" &&
                (row[0] ?? "").includes(search.trim().toLowerCase()),
        ) ?? [],
    );

    const extension = createMutation(() =>
        orpc.resources.queryPostgres.mutationOptions({
            onSuccess: async () => {
                confirmUninstall = false;
                await extensions.refetch();
            },
        }),
    );

    let uninstalling = $state<string>();

    let confirmUninstall = $state(false);

    let regenerating = $state(false);

    const regenerate = createMutation(() =>
        orpc.resources.regeneratePostgresPassword.mutationOptions({
            onSuccess: async () => {
                regenerating = false;
                // Variables changed: the canvas shows the database and its dependents as changed.
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });
            },
        }),
    );

    let pooling = $state(false);

    // Both are already cached by the canvas around this panel.
    const graph = createQuery(() =>
        orpc.resources.getProjectGraph.queryOptions({
            input: { projectId: input.projectId },
        }),
    );

    const projectResources = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId: input.projectId },
        }),
    );

    // A PgDog resource that references this database, like the one Add PgDog creates.
    const existingPooler = $derived.by(() => {
        const entry = graph.data?.resources.find(
            (item) =>
                item.references.includes(input.resourceId) &&
                item.services.some((service) =>
                    service.image?.startsWith(
                        "ghcr.io/pgdogdev/pgdog",
                    ),
                ),
        );

        return entry
            ? projectResources.data?.find(
                  (item) => item.id === entry.id,
              )
            : undefined;
    });

    const pooler = createMutation(() =>
        orpc.resources.addConnectionPooler.mutationOptions({
            onSuccess: async () => {
                pooling = false;
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });
            },
        }),
    );
</script>

{#snippet section(title: string, icon: Component, body: Snippet)}
    {@const Icon = icon}
    <section class="relative pb-14 pl-16" aria-label={title}>
        <span
            class="absolute top-0 left-0 flex size-10 items-center justify-center rounded-full border bg-card text-muted-foreground"
            aria-hidden="true"
        >
            <Icon class="size-4" />
        </span>
        <h3
            class="flex h-10 items-center text-xl text-muted-foreground"
        >
            {title}
        </h3>
        <div class="space-y-6 pt-6">{@render body()}</div>
    </section>
{/snippet}

{#snippet connectionBody()}
    {#if staleRole && credentials}
        <Alert variant="warning">
            <AlertDescription>
                The database's user is still called {staleRole}, from
                an older deploy. Rename it to {credentials.username} so
                these credentials and the apps that reference them work.
            </AlertDescription>
            <AlertAction>
                <Button
                    size="sm"
                    variant="outline"
                    onclick={() => {
                        rename.reset();
                        renaming = true;
                    }}
                >
                    Rename
                </Button>
            </AlertAction>
        </Alert>
    {/if}
    {#if connection.isPending}
        <Skeleton loading label="Loading credentials">
            <div class="grid grid-cols-2 gap-4">
                <div class="h-16 rounded-md border"></div>
                <div class="h-16 rounded-md border"></div>
            </div>
        </Skeleton>
    {:else if credentials}
        <div class="grid gap-4 @md:grid-cols-2">
            <ConnectionField
                label="Username"
                value={credentials.username}
            />
            <ConnectionField
                label="Password"
                value={credentials.password}
                secret
            />
        </div>
    {/if}
    <div
        class="flex items-center justify-between gap-4 border-t pt-4"
    >
        <div>
            <h4 class="text-sm font-semibold">Regenerate Password</h4>
            <p class="mt-1 text-sm text-muted-foreground">
                Breaks existing connections until they use the new
                password.
            </p>
        </div>
        <Button
            variant="outline"
            onclick={() => {
                regenerate.reset();
                regenerating = true;
            }}
        >
            <RefreshCw class="size-4" aria-hidden="true" />
            Regenerate
        </Button>
    </div>
{/snippet}

{#snippet poolingBody()}
    <p class="text-sm text-muted-foreground">
        Add PgDog as a connection pooler to reduce connection overhead
        and improve performance.
    </p>
    {#if existingPooler}
        <p class="text-sm" role="status">
            {existingPooler.name} pools this database. Connect your apps
            to it on port 6432{existingPooler.deploymentStatus ===
            "ready"
                ? ""
                : " once it is deployed"}.
        </p>
    {:else if pooler.data}
        <p class="text-sm" role="status">
            Added {pooler.data.name}. Deploy it, then connect your
            apps to it on port 6432.
        </p>
    {:else if graph.isPending}
        <Skeleton loading label="Checking for a pooler">
            <div class="h-8 w-28 rounded-lg border"></div>
        </Skeleton>
    {:else}
        <Button
            variant="outline"
            onclick={() => {
                pooler.reset();
                pooling = true;
            }}
        >
            Add PgDog
        </Button>
    {/if}
{/snippet}

{#snippet extensionRow(row: (string | null)[], action: Snippet)}
    <li class="flex items-center justify-between gap-4 px-4 py-3">
        <div class="min-w-0">
            <p class="flex items-center gap-2 text-sm font-medium">
                {row[0]}
                <Badge variant="outline">v{row[1]}</Badge>
            </p>
            <p class="truncate text-xs text-muted-foreground">
                {row[3]}
            </p>
        </div>
        {@render action()}
    </li>
{/snippet}

{#snippet extensionsBody()}
    {#if extensions.isPending}
        <Skeleton loading label="Loading extensions">
            <div class="h-24 rounded-md border"></div>
        </Skeleton>
    {:else if extensions.isError}
        <p class="text-sm text-destructive-foreground">
            {extensions.error.message}
        </p>
    {:else}
        {#if extension.error}
            <Alert variant="error">
                <AlertDescription>
                    {extension.error.message}
                </AlertDescription>
            </Alert>
        {/if}
        <div>
            <h4 class="mb-3 text-sm font-semibold">
                {installed.length}
                {installed.length === 1 ? "Extension" : "Extensions"} installed
            </h4>
            <ul class="divide-y rounded-lg border">
                {#each installed as row (row[0])}
                    {#snippet uninstall()}
                        <Button
                            size="sm"
                            variant="ghost"
                            onclick={() => {
                                extension.reset();
                                uninstalling = row[0] ?? undefined;
                                confirmUninstall = true;
                            }}
                        >
                            Uninstall
                        </Button>
                    {/snippet}
                    {@render extensionRow(row, uninstall)}
                {/each}
            </ul>
        </div>
        <div>
            <h4 class="mb-3 text-sm font-semibold">Available</h4>
            <Input
                bind:value={search}
                placeholder="Filter extensions..."
                aria-label="Filter available extensions"
            />
            {#if available.length > 0}
                <ul
                    class="mt-3 max-h-80 divide-y overflow-y-auto rounded-lg border"
                >
                    {#each available as row (row[0])}
                        {#snippet install()}
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={extension.isPending}
                                onclick={() =>
                                    extension.mutate({
                                        ...input,
                                        query: `CREATE EXTENSION IF NOT EXISTS ${quoteIdent(row[0] ?? "")}`,
                                    })}
                            >
                                Install
                            </Button>
                        {/snippet}
                        {@render extensionRow(row, install)}
                    {/each}
                </ul>
            {:else if search.trim()}
                <p class="mt-3 text-sm text-muted-foreground">
                    No available extension matches "{search.trim()}".
                </p>
            {/if}
        </div>
    {/if}
{/snippet}

<!-- Edge to edge like Settings, so the timeline rule runs to the bottom of the panel. -->
<div class="@container flex min-h-full px-12 pt-8">
    <div class="relative max-w-[600px] flex-1">
        <div
            class="absolute top-5 bottom-0 left-5 w-px bg-border"
            aria-hidden="true"
        ></div>
        {@render section("Connection", Plug, connectionBody)}
        {@render section("Connection Pooling", Layers, poolingBody)}
        {@render section("Extensions", Package, extensionsBody)}
    </div>
</div>

<ConfirmDialog
    bind:open={renaming}
    title="Rename {staleRole} to {credentials?.username}?"
    description="Its tables and password stay as they are. Services still connecting as {staleRole}, like the metrics exporter, need a redeploy."
    confirmLabel="Rename"
    pending={rename.isPending}
    error={rename.error?.message}
    onconfirm={() => rename.mutate(input)}
/>

<ConfirmDialog
    bind:open={regenerating}
    title="Regenerate password?"
    description="The database switches to a new password right away. The metrics exporter, pooler and every resource that references it keep the old one until you redeploy them."
    confirmLabel="Regenerate"
    pending={regenerate.isPending}
    error={regenerate.error?.message}
    onconfirm={() => regenerate.mutate(input)}
/>

<ConfirmDialog
    bind:open={confirmUninstall}
    title="Uninstall {uninstalling}?"
    description="Drops the extension. PostgreSQL refuses while tables or functions still depend on it."
    confirmLabel="Uninstall"
    pending={extension.isPending}
    error={extension.error?.message}
    onconfirm={() =>
        extension.mutate({
            ...input,
            query: `DROP EXTENSION ${quoteIdent(uninstalling ?? "")}`,
        })}
/>

<Dialog bind:open={pooling}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Add PgDog</DialogTitle>
            <DialogDescription>
                Adds a PgDog resource that connects to this database
                through variable references. Deploy it to start
                pooling.
            </DialogDescription>
        </DialogHeader>
        {#if pooler.error}
            <DialogPanel>
                <Alert variant="error">
                    <AlertDescription>
                        {pooler.error.message}
                    </AlertDescription>
                </Alert>
            </DialogPanel>
        {/if}
        <DialogFooter>
            <Button
                variant="outline"
                disabled={pooler.isPending}
                onclick={() => (pooling = false)}
            >
                Cancel
            </Button>
            <Button
                loading={pooler.isPending}
                onclick={() => pooler.mutate(input)}
            >
                Add PgDog
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
