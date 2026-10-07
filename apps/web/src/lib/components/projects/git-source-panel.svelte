<script lang="ts">
    import GitSourceFields from "./git-source-fields.svelte";
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardHeader,
        CardPanel,
    } from "$lib/components/ui/card";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { orpc } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";

    let {
        connectionId,
        source,
        busy,
        onaction,
    }: {
        connectionId: string | null;
        source: {
            repositoryUrl: string;
            branch: string;
            path: string;
            revision: string;
        } | null;
        busy: boolean;
        onaction: (
            action: "source" | "pull" | "detach" | "push",
            input?: {
                connectionId: string;
                repositoryUrl: string;
                branch: string;
                path: string;
            },
            message?: string,
        ) => Promise<boolean>;
    } = $props();

    const id = $props.id();

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    const canManage = $derived(
        connectionsQuery.data?.canManage === true &&
            !connectionsQuery.isError,
    );

    const name = $derived(
        connectionsQuery.data?.connections.find(
            (connection) => connection.id === connectionId,
        )?.name ?? "Git repository",
    );

    const repositoryName = $derived(
        source?.repositoryUrl
            .replace(/^[a-z]+:\/\/[^/]+\//, "")
            .replace(/\.git$/, "") ?? "",
    );

    const fields = useQueryStates(
        {
            changing: parseAsBoolean.withDefault(false),
            connectionId: parseAsString.withDefault(""),
            repositoryUrl: parseAsString.withDefault(""),
            branch: parseAsString.withDefault(""),
            path: parseAsString.withDefault("."),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    let message = $state("");

    function changeSource() {
        void fields.set({
            connectionId: connectionId ?? "",
            repositoryUrl: source?.repositoryUrl ?? "",
            branch: source?.branch ?? "",
            path: source?.path ?? ".",
            changing: true,
        });
    }
</script>

<Card
    class="shrink-0"
    role="region"
    aria-label="Git source"
    aria-busy={busy}
>
    <CardHeader
        class="flex flex-row flex-wrap items-center justify-between gap-3 p-4"
    >
        <div class="min-w-0">
            <h2 class="text-sm font-semibold">Git source</h2>
            {#if source}
                <p
                    class="mt-1 break-all text-xs text-muted-foreground"
                >
                    {name} /
                    <span title={source.repositoryUrl}>
                        {repositoryName}
                    </span>
                    / {source.branch} / {source.path}
                    <span class="font-mono" title={source.revision}>
                        ({source.revision.slice(0, 12)})
                    </span>
                </p>
            {:else}
                <p class="mt-1 text-xs text-muted-foreground">
                    Import Compose from a connected repository.
                </p>
            {/if}
        </div>
        <div class="flex flex-wrap gap-2">
            <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onclick={changeSource}
            >
                {source ? "Change source" : "Connect source"}
            </Button>
            {#if source}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onclick={() => onaction("pull")}
                >
                    Pull from Git
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onclick={() => onaction("detach")}
                >
                    Detach
                </Button>
            {/if}
        </div>
    </CardHeader>
    {#if fields.changing.current || source || connectionsQuery.isError}
        <CardPanel class="space-y-3 p-4">
            {#if fields.changing.current}
                <form
                    class="space-y-3"
                    onsubmit={async (event) => {
                        event.preventDefault();
                        if (
                            await onaction("source", {
                                connectionId:
                                    fields.connectionId.current,
                                repositoryUrl:
                                    fields.repositoryUrl.current,
                                branch: fields.branch.current.trim(),
                                path: fields.path.current.trim(),
                            })
                        )
                            void fields.set(null);
                    }}
                >
                    <GitSourceFields
                        bind:connectionId={
                            fields.connectionId.current
                        }
                        bind:repositoryUrl={
                            fields.repositoryUrl.current
                        }
                        bind:branch={fields.branch.current}
                        bind:path={fields.path.current}
                        disabled={busy}
                    />
                    <div class="flex gap-2">
                        <Button
                            size="sm"
                            type="submit"
                            disabled={busy ||
                                !fields.connectionId.current ||
                                !fields.repositoryUrl.current ||
                                !fields.branch.current.trim() ||
                                !fields.path.current.trim()}
                        >
                            Import &amp; bind
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onclick={() => fields.set(null)}
                        >
                            Cancel
                        </Button>
                    </div>
                </form>
            {/if}
            {#if source}
                <p class="text-xs text-muted-foreground">
                    Save draft stays local to Stoat. Pull replaces the
                    local draft. Importing Compose does not deploy
                    relative build contexts or other repository files.
                </p>
                {#if canManage}
                    <form
                        class="flex flex-wrap items-end gap-2"
                        onsubmit={async (event) => {
                            event.preventDefault();
                            if (
                                message.trim() &&
                                (await onaction(
                                    "push",
                                    undefined,
                                    message.trim(),
                                ))
                            )
                                message = "";
                        }}
                    >
                        <div class="min-w-0 flex-1 space-y-1">
                            <Label for="{id}-commit">
                                Commit message
                            </Label>
                            <Input
                                id="{id}-commit"
                                bind:value={message}
                                placeholder="Update Compose configuration"
                                required
                                disabled={busy}
                            />
                        </div>
                        <Button
                            type="submit"
                            size="sm"
                            disabled={busy || !message.trim()}
                        >
                            Commit &amp; push
                        </Button>
                    </form>
                {:else}
                    <p class="text-xs text-muted-foreground">
                        Only administrators can push to Git. Members
                        can import, pull, and save local drafts.
                    </p>
                {/if}
            {/if}
            {#if connectionsQuery.isError}
                <Alert variant="error">
                    <AlertDescription>
                        Unable to load Git permissions: {connectionsQuery
                            .error.message}
                    </AlertDescription>
                    <AlertAction>
                        <Button
                            size="sm"
                            variant="outline"
                            onclick={() => connectionsQuery.refetch()}
                        >
                            Retry
                        </Button>
                    </AlertAction>
                </Alert>
            {/if}
        </CardPanel>
    {/if}
</Card>
