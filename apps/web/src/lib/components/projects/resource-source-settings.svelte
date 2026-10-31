<script lang="ts">
    import GitSourcePanel from "./git-source-panel.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Tabs,
        TabsList,
        TabsPanel,
        TabsTab,
    } from "$lib/components/ui/tabs";
    import { orpc } from "$lib/api/orpc";
    import { GitSourceActions } from "$lib/resources/git-source-actions.svelte";
    import {
        gitProviderLabels,
        gitProviders,
    } from "$lib/params/git-query-params";
    import FileCode2 from "@lucide/svelte/icons/file-code-2";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";

    let {
        projectId,
        resourceId,
    }: {
        projectId: string;
        resourceId: string;
    } = $props();

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
        }),
    );

    const resource = $derived(resourceQuery.data);

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    // The active tab follows the provider of the connection the resource is bound to.
    const savedProvider = $derived(
        connectionsQuery.data?.connections.find(
            (connection) =>
                connection.id === resource?.gitConnectionId,
        )?.provider ?? null,
    );

    const git = new GitSourceActions(
        () => projectId,
        () => resourceId,
        () => resource,
    );

    const savedSource = $derived(git.savedSource);

    const sourceTabs = ["raw", ...gitProviders] as const;

    const tab = useQueryState(
        "source",
        parseAsStringLiteral(sourceTabs).withOptions({
            history: "replace",
            shallow: true,
            scroll: false,
        }),
    );

    const activeTab = $derived(tab.current ?? savedProvider ?? "raw");
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="source-settings-heading"
>
    <div>
        <h2
            id="source-settings-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            Source
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Edit Compose as raw YAML in Stoat, or keep it in sync with
            a Git repository.
        </p>
    </div>

    <div class="space-y-4 md:col-span-2">
        {#if savedSource && connectionsQuery.isPending}
            <Skeleton loading label="Loading source settings">
                <div class="space-y-4">
                    <div class="h-9.5 w-64 rounded-lg bg-muted"></div>
                    <Card>
                        <CardPanel class="p-5 sm:p-6">
                            <p class="text-sm">Git source</p>
                            <p
                                class="mt-1 text-xs text-muted-foreground"
                            >
                                repository / main / compose.yaml
                            </p>
                        </CardPanel>
                    </Card>
                </div>
            </Skeleton>
        {:else}
            <Tabs
                value={activeTab}
                onValueChange={(value) => {
                    const next = sourceTabs.find(
                        (candidate) => candidate === value,
                    );
                    if (next) void tab.set(next);
                }}
            >
                <TabsList>
                    <TabsTab value="raw">
                        <FileCode2 aria-hidden="true" />
                        <span class="sr-only sm:not-sr-only">
                            Raw
                        </span>
                    </TabsTab>
                    {#each gitProviders as provider (provider)}
                        <TabsTab value={provider}>
                            <ProviderIcon {provider} />
                            <span class="sr-only sm:not-sr-only">
                                {gitProviderLabels[provider]}
                            </span>
                        </TabsTab>
                    {/each}
                </TabsList>
                <TabsPanel value="raw">
                    <Card>
                        <CardPanel class="space-y-3 p-5 sm:p-6">
                            {#if savedSource}
                                <p
                                    class="text-sm text-muted-foreground"
                                >
                                    This resource is bound to a Git
                                    repository. Detach it to manage
                                    Compose only in Stoat. The current
                                    draft is kept.
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    loading={git.pending}
                                    disabled={git.pending}
                                    onclick={() => git.run("detach")}
                                >
                                    Detach Git source
                                </Button>
                            {:else}
                                <p
                                    class="text-sm text-muted-foreground"
                                >
                                    Compose is edited directly in the
                                    resource editor and saved as a
                                    draft in Stoat.
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    href="/projects/{projectId}/{resourceId}"
                                >
                                    Open editor
                                </Button>
                            {/if}
                        </CardPanel>
                    </Card>
                </TabsPanel>
                {#each gitProviders as provider (provider)}
                    <TabsPanel value={provider}>
                        <GitSourcePanel
                            {provider}
                            connectionId={savedSource?.connectionId ??
                                null}
                            source={savedSource}
                            busy={git.pending}
                            onaction={(action, source, message) =>
                                git.run(action, source, message)}
                            onwatch={(autoDeploy, watchPath) =>
                                git.run(
                                    "watch",
                                    undefined,
                                    undefined,
                                    {
                                        autoDeploy,
                                        watchPath,
                                    },
                                )}
                        />
                    </TabsPanel>
                {/each}
            </Tabs>
        {/if}
        {#if git.error}
            <Alert variant="error">
                <AlertDescription>{git.error}</AlertDescription>
            </Alert>
        {:else if git.status}
            <Alert variant="success" role="status">
                <AlertDescription>{git.status}</AlertDescription>
            </Alert>
        {/if}
    </div>
</section>

<ConfirmDialog
    bind:open={
        () => git.confirmation !== null,
        (open) => {
            if (!open) git.answer(false);
        }
    }
    title={git.confirmation?.title ?? ""}
    description={git.confirmation?.description ?? ""}
    confirmLabel={git.confirmation?.confirmLabel ?? "Confirm"}
    onconfirm={() => git.answer(true)}
/>
