<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import type { GitSourceActions } from "$lib/resources/git-source-actions.svelte";
    import FileCode2 from "@lucide/svelte/icons/file-code-2";
    import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import Pencil from "@lucide/svelte/icons/pencil";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import CanvasSourceDialog from "../canvas-source-dialog.svelte";
    import SettingsTitle from "./settings-title.svelte";
    import SettingsToggle from "./settings-toggle.svelte";

    let {
        git,
        isAdmin,
        shows,
    }: {
        git: GitSourceActions;
        isAdmin: boolean;
        shows: (...words: string[]) => boolean;
    } = $props();

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    const source = $derived(git.savedSource);

    const connection = $derived(
        connectionsQuery.data?.connections.find(
            (candidate) => candidate.id === source?.connectionId,
        ),
    );

    const repositoryName = $derived(
        source?.repositoryUrl
            .replace(/^[a-z]+:\/\/[^/]+\//u, "")
            .replace(/^[^@]+@[^:]+:/u, "")
            .replace(/\.git$/u, "") ?? "",
    );

    // SSH remotes have no page to open; HTTPS ones drop the `.git` suffix.
    const repositoryHref = $derived(
        source?.repositoryUrl.startsWith("https://")
            ? source.repositoryUrl.replace(/\.git$/u, "")
            : undefined,
    );

    let sourceDialogOpen = $state(false);

    // The panel's tab, so Compose can be opened from here; pushed like the panel's own tabs.
    const tab = useQueryState(
        "tab",
        parseAsString.withOptions({
            history: "push",
            shallow: true,
            scroll: false,
        }),
    );

    // Follows the saved value until edited; saving or a refetch resets it.
    let watchPath = $derived(source?.watchPath ?? ".");

    let commitMessage = $state("");
</script>

{#if source}
    {#if shows("source", "repo", "git")}
        <div>
            <SettingsTitle text={"Source Repo"} />
            <div
                class="mt-3 flex items-center gap-4 rounded-md bg-muted/60 px-4 py-3"
            >
                {#if connection}
                    <ProviderIcon provider={connection.provider} />
                {:else}
                    <FolderGit2
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                {/if}
                <div class="min-w-0 flex-1">
                    {#if repositoryHref}
                        <a
                            href={repositoryHref}
                            target="_blank"
                            rel="noreferrer"
                            class="block truncate text-base hover:underline"
                        >
                            {repositoryName}
                        </a>
                    {:else}
                        <p class="truncate text-base">
                            {repositoryName}
                        </p>
                    {/if}
                    <p class="truncate text-xs text-muted-foreground">
                        {connection?.name ?? "Git"} · at
                        <span
                            class="font-mono"
                            title={source.revision}
                        >
                            {source.revision.slice(0, 7)}
                        </span>
                    </p>
                </div>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Change source"
                    disabled={git.pending}
                    onclick={() => (sourceDialogOpen = true)}
                >
                    <Pencil class="size-4" aria-hidden="true" />
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={git.pending}
                    onclick={() => void git.run("detach")}
                >
                    Disconnect
                </Button>
            </div>
        </div>
    {/if}

    {#if shows("branch", "source")}
        <div>
            <SettingsTitle
                text={"Branch"}
                description={"Pushes to this branch are what auto deploy picks up."}
            />
            <div
                class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
            >
                <GitBranch
                    class="size-4 shrink-0"
                    aria-hidden="true"
                />
                <span
                    class="min-w-0 flex-1 truncate font-mono text-sm"
                >
                    {source.branch}
                </span>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Change branch"
                    disabled={git.pending}
                    onclick={() => (sourceDialogOpen = true)}
                >
                    <Pencil class="size-4" aria-hidden="true" />
                </Button>
            </div>
        </div>
    {/if}

    {#if shows("compose file", "config", "source")}
        <div>
            <SettingsTitle
                text={"Compose File"}
                description={"The Compose file deployed from the repository. Relative config files it references are read from Git too; build contexts are not."}
            />
            <div
                class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
            >
                <FileCode2
                    class="size-4 shrink-0"
                    aria-hidden="true"
                />
                <span
                    class="min-w-0 flex-1 truncate font-mono text-sm"
                >
                    {source.path}
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => void tab.set("compose")}
                >
                    Edit
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Change Compose file"
                    disabled={git.pending}
                    onclick={() => (sourceDialogOpen = true)}
                >
                    <Pencil class="size-4" aria-hidden="true" />
                </Button>
            </div>
        </div>
    {/if}

    {#if isAdmin && shows("watch directory", "auto deploy", "deploy")}
        <form
            onsubmit={(event) => {
                event.preventDefault();
                void git.run("watch", undefined, undefined, {
                    autoDeploy: source.autoDeploy,
                    watchPath: watchPath.trim(),
                });
            }}
        >
            <SettingsTitle
                text={"Watch Directory"}
                description={"Only pushes that change files in this directory start a new deployment."}
            />
            <div class="mt-3 flex gap-2">
                <Input
                    bind:value={watchPath}
                    placeholder="."
                    aria-label="Watch directory"
                    class="font-mono"
                    disabled={git.pending}
                />
                <Button
                    type="submit"
                    variant="outline"
                    disabled={git.pending ||
                        watchPath.trim() === source.watchPath}
                >
                    Save
                </Button>
            </div>
        </form>

        <div>
            <SettingsTitle
                text={"Auto Deploy"}
                description={`Pull and deploy when ${source.branch} changes. Right away with the Git connection's push webhook, otherwise within a minute. Paused while the draft has changes that are not in Git.`}
            />
            <SettingsToggle
                label="Deploy on push"
                checked={source.autoDeploy}
                disabled={git.pending}
                onchange={(checked) =>
                    void git.run("watch", undefined, undefined, {
                        autoDeploy: checked,
                        watchPath: source.watchPath,
                    })}
            />
        </div>
    {/if}

    {#if shows("pull", "push", "commit", "sync")}
        <div>
            <SettingsTitle
                text={"Sync"}
                description={`Pull replaces the saved draft with ${source.branch}. Deploying commits draft changes to ${source.branch} first.`}
            />
            <div class="mt-3 flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    disabled={git.pending}
                    onclick={() => void git.run("pull")}
                >
                    Pull from Git
                </Button>
            </div>
            {#if isAdmin}
                <form
                    class="mt-3 flex gap-2"
                    onsubmit={async (event) => {
                        event.preventDefault();

                        if (
                            await git.run(
                                "push",
                                undefined,
                                commitMessage,
                            )
                        )
                            commitMessage = "";
                    }}
                >
                    <Input
                        bind:value={commitMessage}
                        placeholder="Update Compose configuration"
                        aria-label="Commit message"
                        disabled={git.pending}
                    />
                    <Button
                        type="submit"
                        disabled={git.pending ||
                            !commitMessage.trim()}
                    >
                        Commit &amp; push
                    </Button>
                </form>
            {/if}
        </div>
    {/if}
{:else}
    <div>
        <SettingsTitle
            text={"Source Repo"}
            description={"Compose is edited in Stoat. Connect a repository to deploy its Compose file and configs from Git instead."}
        />
        <div class="mt-3 flex flex-wrap gap-2">
            <Button
                variant="outline"
                disabled={git.pending}
                onclick={() => (sourceDialogOpen = true)}
            >
                <FolderGit2 class="size-4" aria-hidden="true" />
                Connect Repo
            </Button>
            <Button
                variant="ghost"
                onclick={() => void tab.set("compose")}
            >
                Open editor
            </Button>
        </div>
    </div>
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

<CanvasSourceDialog
    bind:open={sourceDialogOpen}
    {source}
    busy={git.pending}
    onsubmit={(next) => git.run("source", next)}
/>

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
