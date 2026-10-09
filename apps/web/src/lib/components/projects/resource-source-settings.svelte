<script lang="ts">
    import GitSourcePanel from "./git-source-panel.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import {
        Tabs,
        TabsList,
        TabsPanel,
        TabsTab,
    } from "$lib/components/ui/tabs";
    import { client, orpc, queryClient } from "$lib/api/orpc";
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

    const tab = useQueryState(
        "source",
        parseAsStringLiteral(["raw", "git"]).withOptions({
            history: "replace",
            shallow: true,
            scroll: false,
        }),
    );

    const activeTab = $derived(
        tab.current ?? (savedSource ? "git" : "raw"),
    );

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
        <Tabs
            value={activeTab}
            onValueChange={(value) =>
                void tab.set(value === "git" ? "git" : "raw")}
        >
            <TabsList>
                <TabsTab value="raw">Raw</TabsTab>
                <TabsTab value="git">Git</TabsTab>
            </TabsList>
            <TabsPanel value="raw">
                <Card>
                    <CardPanel class="space-y-3 p-5 sm:p-6">
                        {#if savedSource}
                            <p class="text-sm text-muted-foreground">
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
                                onclick={() => gitAction("detach")}
                            >
                                Detach Git source
                            </Button>
                        {:else}
                            <p class="text-sm text-muted-foreground">
                                Compose is edited directly in the
                                resource editor and saved as a draft
                                in Stoat.
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
            <TabsPanel value="git">
                <GitSourcePanel
                    connectionId={savedSource?.connectionId ?? null}
                    source={savedSource}
                    busy={pending}
                    onaction={gitAction}
                />
            </TabsPanel>
        </Tabs>
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
