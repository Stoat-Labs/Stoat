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
    import { client, orpc, queryClient } from "$lib/api/orpc";
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

    // Settings has no editor, so the saved draft is the only Compose to compare and push.
    const savedSpec = $derived(resource?.draftSpec ?? null);

    const savedSource = $derived(
        resource?.gitConnectionId && resource.gitSource
            ? {
                  connectionId: resource.gitConnectionId,
                  ...resource.gitSource,
              }
            : null,
    );

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

    let pending = $state(false);

    let error = $state("");

    let status = $state("");

    const statusMessages = {
        source: "Compose imported from Git.",
        pull: "Compose imported from Git.",
        push: "Commit pushed and draft saved.",
        detach: "Git source detached. Compose retained.",
    };

    // A Git action waiting for an answer in the confirmation dialog.
    let confirmation = $state<{
        title: string;
        description: string;
        confirmLabel: string;
        answer: (confirmed: boolean) => void;
    } | null>(null);

    function confirm(
        title: string,
        description: string,
        confirmLabel: string,
    ) {
        return new Promise<boolean>((answer) => {
            confirmation = {
                title,
                description,
                confirmLabel,
                answer,
            };
        });
    }

    function answer(confirmed: boolean) {
        confirmation?.answer(confirmed);
        confirmation = null;
    }

    async function gitAction(
        action: "source" | "pull" | "detach" | "push",
        source?: {
            connectionId: string;
            repositoryUrl: string;
            branch: string;
            path: string;
        },
        message?: string,
    ) {
        if (pending || !resource) return false;

        if (
            (action === "source" || action === "pull") &&
            savedSpec !== null &&
            !(await confirm(
                "Replace the Compose draft?",
                "The Git version replaces the saved draft.",
                "Replace",
            ))
        )
            return false;

        if (
            action === "detach" &&
            !(await confirm(
                "Detach the Git source?",
                "The current Compose draft is kept.",
                "Detach",
            ))
        )
            return false;

        if (pending) return false;
        const input = { projectId, resourceId };
        const expectedSpec = savedSpec;

        const expectedSource = savedSource
            ? { ...savedSource }
            : null;

        const expectedRevision = expectedSource?.revision;
        pending = true;
        error = status = "";

        try {
            let updated;

            if (action === "source" && source) {
                updated = await client.resources.setGitSource({
                    ...input,
                    ...source,
                    expectedSpec,
                    expectedSource,
                });
            } else if (action === "pull") {
                updated = await client.resources.pullGitSource({
                    ...input,
                    expectedSpec,
                    expectedSource,
                });
            } else if (action === "detach") {
                updated = await client.resources.detachGitSource({
                    ...input,
                    expectedSpec,
                    expectedSource,
                });
            } else if (
                action === "push" &&
                expectedRevision &&
                message?.trim()
            ) {
                updated = await client.resources.pushGitSource({
                    ...input,
                    spec: expectedSpec ?? "",
                    expectedSpec,
                    expectedSource,
                    expectedRevision,
                    message: message.trim(),
                });
            } else return false;
            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.queryKey({
                    input: { projectId: input.projectId },
                }),
            });
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getContainers.key({ input }),
            });
            status = statusMessages[action];

            return true;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Git operation failed.";

            return false;
        } finally {
            pending = false;
        }
    }
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
            <Skeleton loading loading-label="Loading source settings">
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
                                    loading={pending}
                                    disabled={pending}
                                    onclick={() =>
                                        gitAction("detach")}
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
                            busy={pending}
                            onaction={gitAction}
                        />
                    </TabsPanel>
                {/each}
            </Tabs>
        {/if}
        {#if error}
            <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {:else if status}
            <Alert variant="success" role="status">
                <AlertDescription>{status}</AlertDescription>
            </Alert>
        {/if}
    </div>
</section>

<ConfirmDialog
    bind:open={
        () => confirmation !== null,
        (open) => {
            if (!open) answer(false);
        }
    }
    title={confirmation?.title ?? ""}
    description={confirmation?.description ?? ""}
    confirmLabel={confirmation?.confirmLabel ?? "Confirm"}
    onconfirm={() => answer(true)}
/>
