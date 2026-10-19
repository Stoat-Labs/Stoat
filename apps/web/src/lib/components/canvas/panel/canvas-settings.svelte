<script lang="ts">
    import { page } from "$app/state";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import BucketLimitDialog from "$lib/components/s3/bucket-limit-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Switch } from "$lib/components/ui/switch";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { bucketJobPollInterval } from "$lib/s3";
    import { bytes } from "$lib/observability";
    import { GitSourceActions } from "$lib/resources/git-source-actions.svelte";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import Cable from "@lucide/svelte/icons/cable";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import Code from "@lucide/svelte/icons/code";
    import Copy from "@lucide/svelte/icons/copy";
    import FileCode2 from "@lucide/svelte/icons/file-code-2";
    import Flame from "@lucide/svelte/icons/flame";
    import FolderGit2 from "@lucide/svelte/icons/folder-git-2";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import Globe from "@lucide/svelte/icons/globe";
    import Network from "@lucide/svelte/icons/network";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Plus from "@lucide/svelte/icons/plus";
    import Rocket from "@lucide/svelte/icons/rocket";
    import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import {
        parseIngressCompose,
        removeIngressFromCompose,
        removeServiceCaddy,
        type HostIngress,
        type HttpIngress,
        type IngressEntry,
    } from "@stoat/workflows/ingress";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryState,
    } from "nuqs-svelte";
    import type { Component, Snippet } from "svelte";
    import { z } from "zod";
    import CanvasIngressDialog, {
        type IngressMode,
    } from "./canvas-ingress-dialog.svelte";
    import CanvasSourceDialog from "./canvas-source-dialog.svelte";
    import { getCanvasActions } from "../context";
    import type { CanvasResource, CanvasService } from "../graph";

    let {
        resource,
        services,
    }: {
        resource: CanvasResource;
        services: CanvasService[];
    } = $props();

    const actions = getCanvasActions();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({ input }),
    );

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: resource.projectId },
        }),
    );

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    const details = $derived(resourceQuery.data);

    const isBucket = $derived(resource.type === "bucket");

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({
            input: {
                projectId: resource.projectId,
                resourceId: resource.id,
            },
            enabled: isBucket,
            refetchInterval: (query) =>
                bucketJobPollInterval(query.state.data?.status),
            retry: false,
        }),
    );

    const bucket = $derived(bucketQuery.data);

    const limitDialog = useQueryState(
        "limitDialog",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );

    const isAdmin = $derived(page.data.isOrganizationAdmin === true);

    // System-managed resources keep their source and cannot be deleted.
    // Treated as internal until the project loads, so Source and Delete never flash for one.
    const isInternal = $derived(
        !projectQuery.isSuccess ||
            projectQuery.data.isInternal === true,
    );

    const git = new GitSourceActions(
        () => resource.projectId,
        () => resource.id,
        () => details,
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

    // Follows the saved value until edited; saving or a refetch resets it.
    let watchPath = $derived(source?.watchPath ?? ".");

    let commitMessage = $state("");

    const settingsSchema = z
        .object({ prefixNames: z.boolean().catch(true) })
        .catch({ prefixNames: true });

    const prefixNames = $derived(
        settingsSchema.parse(details?.settings).prefixNames,
    );

    let savingPrefix = $state(false);

    let prefixError = $state("");

    async function setPrefixNames(checked: boolean) {
        savingPrefix = true;
        prefixError = "";

        try {
            const updated = await client.resources.updateSettings({
                ...input,
                prefixNames: checked,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            // The Apply bar reads pending changes from the graph, which this setting changes.
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });
        } catch (cause) {
            prefixError =
                cause instanceof Error
                    ? cause.message
                    : "Could not save.";
        } finally {
            savingPrefix = false;
        }
    }

    const envSchema = z
        .object({ env: z.string().catch("") })
        .catch({ env: "" });

    // Ingress is edited in the draft, like the Ingress page; the next deploy publishes it.
    const draftCompose = $derived(details?.draftSpec ?? "");

    const ingress = $derived.by(() => {
        try {
            return parseIngressCompose(
                draftCompose,
                envSchema.parse(details?.settings).env,
            );
        } catch {
            return null;
        }
    });

    const ingressEntries = $derived(ingress?.entries ?? []);

    let ingressDialog = $state<{
        mode: IngressMode;
        entry: HttpIngress | HostIngress | null;
    } | null>(null);

    let ingressRemoval = $state<IngressEntry | null>(null);

    let savingIngress = $state(false);

    let ingressError = $state("");

    const canEditIngress = $derived(
        !isInternal && ingress !== null && !savingIngress,
    );

    /** Saves the draft with new ingress; resolves to the error message, or null once saved. */
    async function saveIngress(compose: string) {
        if (!details) return "The resource is still loading.";

        savingIngress = true;
        ingressError = "";

        try {
            const updated = await client.resources.updateComposeSpec({
                ...input,
                spec: compose,
                expectedSpec: details.draftSpec,
                expectedSource: source ? { ...source } : null,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });

            return null;
        } catch (cause) {
            return cause instanceof Error
                ? cause.message
                : "Unable to update the Compose file.";
        } finally {
            savingIngress = false;
        }
    }

    async function removeIngress(entry: IngressEntry) {
        try {
            ingressError =
                (await saveIngress(
                    entry.kind === "caddy"
                        ? removeServiceCaddy(
                              draftCompose,
                              entry.service,
                          )
                        : removeIngressFromCompose(
                              draftCompose,
                              entry.service,
                              entry.raw,
                          ),
                )) ?? "";
        } catch (cause) {
            ingressError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }
    }

    function ingressLabel(entry: IngressEntry) {
        if (entry.kind === "http")
            return entry.hostname ?? "Cluster default domain";

        if (entry.kind === "host")
            return `${entry.bind ?? "*"}:${entry.hostPort}`;

        return "Custom Caddy";
    }

    const privateHosts = $derived(
        services.flatMap((service) =>
            service.internalHostname
                ? [
                      {
                          hostname: service.internalHostname,
                          service: service.name,
                      },
                  ]
                : [],
        ),
    );

    // Railway's settings search; kept in the URL like the open tab.
    const filter = useQueryState(
        "settingsFilter",
        parseAsString
            .withDefault("")
            .withOptions({ shallow: true, scroll: false }),
    );

    const needle = $derived(filter.current.trim().toLowerCase());

    function shows(...words: string[]) {
        return (
            !needle ||
            words.some((word) => word.toLowerCase().includes(needle))
        );
    }

    type Section = {
        id: string;
        title: string;
        icon: Component;
        visible: boolean;
    };

    const sections: Section[] = $derived([
        {
            id: "source",
            title: "Source",
            icon: Code,
            visible:
                !isBucket &&
                !isInternal &&
                shows(
                    "source",
                    "repo",
                    "git",
                    "branch",
                    "compose file",
                    "watch directory",
                    "auto deploy",
                    "pull",
                    "push",
                    "commit",
                ),
        },
        {
            id: "networking",
            title: "Networking",
            icon: Network,
            visible:
                !isBucket &&
                shows(
                    "networking",
                    "public",
                    "domain",
                    "port",
                    "private",
                    "internal",
                    "dns",
                ),
        },
        {
            id: "deploy",
            title: "Deploy",
            icon: Rocket,
            visible:
                !isBucket &&
                shows("deploy", "prefix names", "compose"),
        },
        {
            id: "general",
            title: "General",
            icon: SlidersHorizontal,
            visible: shows(
                "general",
                "name",
                "rename",
                "icon",
                "project",
                "move",
                "copy",
                "duplicate",
            ),
        },
        {
            id: "storage",
            title: "Storage",
            icon: HardDrive,
            visible: isBucket && shows("storage", "limit", "quota"),
        },
        {
            id: "danger",
            title: "Danger",
            icon: Flame,
            visible:
                isAdmin && !isInternal && shows("danger", "delete"),
        },
    ]);

    const visibleSections = $derived(
        sections.filter((section) => section.visible),
    );

    let filterInput = $state<HTMLInputElement | null>(null);

    function jump(id: string) {
        document
            .getElementById(`settings-${id}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
</script>

<svelte:window
    onkeydown={(event) => {
        // Railway focuses the settings filter on "/", unless something else has focus.
        if (
            event.key === "/" &&
            event.target instanceof HTMLElement &&
            !event.target.closest(
                "input, textarea, [contenteditable]",
            )
        ) {
            event.preventDefault();
            filterInput?.focus();
        }
    }}
/>

{#snippet title(text: string, description?: string)}
    <h4 class="text-sm font-semibold">{text}</h4>
    {#if description}
        <p class="mt-1 text-sm text-muted-foreground">
            {description}
        </p>
    {/if}
{/snippet}

<!-- A Railway toggle row: a tinted bar holding the switch and its label. -->
{#snippet toggleRow(
    label: string,
    checked: boolean,
    disabled: boolean,
    onchange: (checked: boolean) => void,
)}
    <label
        class="mt-3 flex cursor-pointer items-center gap-4 rounded-md bg-muted/60 px-4 py-3"
    >
        <Switch
            {checked}
            {disabled}
            onCheckedChange={(next) => onchange(next)}
        />
        <span class="text-base">{label}</span>
    </label>
{/snippet}

{#snippet sourceSection()}
    {#if source}
        {#if shows("source", "repo", "git")}
            <div>
                {@render title("Source Repo")}
                <div
                    class="mt-3 flex items-center gap-4 rounded-md bg-muted/60 px-4 py-3"
                >
                    {#if connection}
                        <ProviderIcon
                            provider={connection.provider}
                        />
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
                        <p
                            class="truncate text-xs text-muted-foreground"
                        >
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
                {@render title(
                    "Branch",
                    "Pushes to this branch are what auto deploy picks up.",
                )}
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
                {@render title(
                    "Compose File",
                    "The Compose file deployed from the repository. Relative config files it references are read from Git too; build contexts are not.",
                )}
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
                {@render title(
                    "Watch Directory",
                    "Only pushes that change files in this directory start a new deployment.",
                )}
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
                {@render title(
                    "Auto Deploy",
                    `Pull and deploy when ${source.branch} changes. Right away with the Git connection's push webhook, otherwise within a minute. Paused while the draft has changes that are not in Git.`,
                )}
                {@render toggleRow(
                    "Deploy on push",
                    source.autoDeploy,
                    git.pending,
                    (checked) =>
                        void git.run("watch", undefined, undefined, {
                            autoDeploy: checked,
                            watchPath: source.watchPath,
                        }),
                )}
            </div>
        {/if}

        {#if shows("pull", "push", "commit", "sync")}
            <div>
                {@render title(
                    "Sync",
                    `Pull replaces the saved draft with ${source.branch}. Deploying commits draft changes to ${source.branch} first.`,
                )}
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
            {@render title(
                "Source Repo",
                "Compose is edited in Stoat. Connect a repository to deploy its Compose file and configs from Git instead.",
            )}
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
                    href="/projects/{resource.projectId}/{resource.id}"
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
{/snippet}

<!-- Railway's networking row: icon, a name with a muted line beneath, actions on the right. -->
{#snippet networkRow(
    icon: Component,
    iconClass: string,
    name: string,
    href: string | undefined,
    detail: Snippet,
    copyText: string | undefined,
    entry: IngressEntry | null,
)}
    {@const Icon = icon}
    <div class="flex items-center gap-4 rounded-md border px-4 py-3">
        <Icon
            class={["size-5 shrink-0", iconClass]}
            aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
            {#if href}
                <a
                    {href}
                    target="_blank"
                    rel="noreferrer"
                    class="block truncate hover:underline"
                >
                    {name}
                </a>
            {:else}
                <p class="truncate">{name}</p>
            {/if}
            <p
                class="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"
            >
                {@render detail()}
            </p>
        </div>
        <div class="flex shrink-0 items-center">
            {#if copyText}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Copy {name}"
                    onclick={() =>
                        void navigator.clipboard.writeText(copyText)}
                >
                    <Copy class="size-4" aria-hidden="true" />
                </Button>
            {/if}
            {#if entry && !isInternal}
                {#if entry.kind === "caddy"}
                    <!-- A Caddyfile has no Railway form; the Ingress page edits it. -->
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit {name} on the Ingress page"
                        href="/projects/{resource.projectId}/{resource.id}/ingress"
                    >
                        <Pencil class="size-4" aria-hidden="true" />
                    </Button>
                {:else}
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit {name}"
                        disabled={!canEditIngress}
                        onclick={() =>
                            (ingressDialog = {
                                mode:
                                    entry.kind === "http"
                                        ? "domain"
                                        : "tcp",
                                entry,
                            })}
                    >
                        <Pencil class="size-4" aria-hidden="true" />
                    </Button>
                {/if}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove {name}"
                    disabled={!canEditIngress}
                    onclick={() => (ingressRemoval = entry)}
                >
                    <Trash2 class="size-4" aria-hidden="true" />
                </Button>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet networkingSection()}
    {#if shows("networking", "public", "domain", "port")}
        <div>
            {@render title(
                "Public Networking",
                "Access your application over HTTP with the following domains.",
            )}
            <div class="mt-3 space-y-2">
                {#each ingressEntries as entry (entry.kind === "caddy" ? `caddy/${entry.service}` : `${entry.service}/${entry.raw}`)}
                    {@const url =
                        entry.kind === "http" && entry.hostname
                            ? `${entry.protocol}://${entry.hostname}`
                            : undefined}
                    {#snippet detail()}
                        {#if entry.kind === "caddy"}
                            Caddyfile routes
                        {:else}
                            <ArrowRight
                                class="size-3 shrink-0"
                                aria-hidden="true"
                            />
                            Port {entry.containerPort}
                            {#if entry.kind === "host"}
                                · {entry.protocol.toUpperCase()}
                            {/if}
                        {/if}
                        {#if services.length > 1}
                            · {entry.service}
                        {/if}
                    {/snippet}
                    {@render networkRow(
                        entry.kind === "http" ? Globe : Cable,
                        "text-muted-foreground",
                        ingressLabel(entry),
                        url,
                        detail,
                        url ??
                            (entry.kind === "host"
                                ? ingressLabel(entry)
                                : undefined),
                        entry,
                    )}
                {:else}
                    <p
                        class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                    >
                        {ingress === null
                            ? "The Compose draft is not valid YAML, so its ingress can't be read."
                            : "Nothing is public yet."}
                    </p>
                {/each}
            </div>
            {#if ingressError}
                <Alert variant="error" class="mt-3">
                    <AlertDescription>
                        {ingressError}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if !isInternal}
                <div class="mt-3 flex flex-wrap gap-2">
                    <Button
                        variant="outline"
                        disabled={!canEditIngress}
                        onclick={() =>
                            (ingressDialog = {
                                mode: "domain",
                                entry: null,
                            })}
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        Custom Domain
                    </Button>
                    <Button
                        variant="outline"
                        disabled={!canEditIngress}
                        onclick={() =>
                            (ingressDialog = {
                                mode: "tcp",
                                entry: null,
                            })}
                    >
                        <Plus class="size-4" aria-hidden="true" />
                        TCP Proxy
                    </Button>
                </div>
            {/if}
        </div>
    {/if}

    {#if shows("networking", "private", "internal", "dns")}
        <div>
            {@render title(
                "Private Networking",
                "Communicate with this service from anywhere in the cluster.",
            )}
            <div class="mt-3 space-y-2">
                {#each privateHosts as entry (entry.hostname)}
                    {#snippet detail()}
                        Ready to talk privately
                        {#if services.length > 1}
                            <span>· {entry.service}</span>
                        {/if}
                    {/snippet}
                    {@render networkRow(
                        CircleCheck,
                        "text-success-foreground",
                        entry.hostname,
                        undefined,
                        detail,
                        entry.hostname,
                        null,
                    )}
                {:else}
                    <p
                        class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                    >
                        Private hostnames appear after the first
                        deploy.
                    </p>
                {/each}
            </div>
        </div>
    {/if}
{/snippet}

{#snippet deploySection()}
    <div>
        {@render title(
            "Prefix Names",
            "Prefix service, network and volume names with this project's and resource's IDs, so they stay unique across the cluster. Changing it renames everything on the next deploy: services are replaced, and volumes start empty under their new names. The old volumes stay on the machines.",
        )}
        {@render toggleRow(
            "Prefix names",
            prefixNames,
            savingPrefix || isInternal,
            (checked) => void setPrefixNames(checked),
        )}
        {#if prefixError}
            <Alert variant="error" class="mt-3">
                <AlertDescription>{prefixError}</AlertDescription>
            </Alert>
        {/if}
    </div>
{/snippet}

{#snippet generalSection()}
    <div>
        {@render title("Name")}
        <div
            class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
        >
            <span class="min-w-0 flex-1 truncate">
                {resource.name}
            </span>
            <Button
                size="sm"
                variant="outline"
                onclick={() => actions.edit("rename", resource.id)}
            >
                Rename
            </Button>
        </div>
    </div>
    <div>
        {@render title(
            "Icon",
            "Shown on the canvas and in the sidebar.",
        )}
        <div class="mt-3 flex flex-wrap gap-2">
            <Button
                variant="outline"
                onclick={() =>
                    actions.edit("icon-upload", resource.id)}
            >
                Upload image
            </Button>
            <Button
                variant="outline"
                onclick={() => actions.edit("icon-link", resource.id)}
            >
                Use a link
            </Button>
        </div>
    </div>
    {#if !isBucket && !isInternal && shows("project", "move", "copy", "duplicate")}
        <div>
            {@render title(
                "Project",
                "Move it to another project, or copy its configuration into one. A deployed resource can't move to another cluster.",
            )}
            <div class="mt-3 flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    onclick={() => actions.edit("move", resource.id)}
                >
                    Move to Project
                </Button>
                <Button
                    variant="outline"
                    onclick={() => actions.edit("copy", resource.id)}
                >
                    Copy to Project
                </Button>
            </div>
        </div>
    {/if}
{/snippet}

{#snippet storageSection()}
    <div>
        {@render title(
            "Storage limit",
            "Cap how much this bucket can hold.",
        )}
        <div
            class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
        >
            <div class="min-w-0 flex-1">
                <p class="truncate">
                    {bucket?.quota ? bytes(bucket.quota) : "No limit"}
                </p>
                {#if bucket}
                    <p class="truncate text-sm text-muted-foreground">
                        {bucket.enforcedQuota
                            ? `${bucket.connection.providerName} rejects uploads past the limit.`
                            : `Display only: ${bucket.connection.providerName} cannot enforce a limit.`}
                    </p>
                {/if}
            </div>
            {#if isAdmin}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={bucket?.status !== "ready"}
                    onclick={() => void limitDialog.set(true)}
                >
                    {bucket?.quota ? "Edit limit" : "Set limit"}
                </Button>
            {/if}
        </div>
    </div>
{/snippet}

{#snippet dangerSection()}
    <div>
        <h4 class="text-sm font-medium text-destructive-foreground">
            {isBucket ? "Delete Bucket" : "Delete Resource"}
        </h4>
        <p class="mt-1 text-sm text-destructive-foreground">
            {isBucket
                ? "Revokes this bucket's keys and removes it from the project. A bucket that still holds objects is kept at the provider."
                : "Stops its services on the cluster and removes it from the project. This cannot be undone."}
        </p>
        <Button
            variant="destructive"
            class="mt-4"
            onclick={() => actions.remove(resource.id)}
        >
            {isBucket ? "Delete bucket" : "Delete resource"}
        </Button>
    </div>
{/snippet}

{#snippet body(id: string)}
    {#if id === "source"}
        {@render sourceSection()}
    {:else if id === "networking"}
        {@render networkingSection()}
    {:else if id === "deploy"}
        {@render deploySection()}
    {:else if id === "general"}
        {@render generalSection()}
    {:else if id === "storage"}
        {@render storageSection()}
    {:else}
        {@render dangerSection()}
    {/if}
{/snippet}

<div class="@container flex min-h-full flex-col">
    <!-- Railway's filter bar, pinned under the tabs. -->
    <div class="sticky top-0 z-10 border-b bg-card px-3 py-3">
        <div class="relative">
            <Input
                bind:ref={filterInput}
                value={filter.current}
                oninput={(event) =>
                    void filter.set(
                        event.currentTarget.value || null,
                    )}
                placeholder="Filter settings..."
                aria-label="Filter settings"
            />
            <kbd
                class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border px-1.5 font-mono text-xs text-muted-foreground"
            >
                /
            </kbd>
        </div>
    </div>

    {#if resourceQuery.isPending}
        <Skeleton
            loading
            loading-label="Loading settings"
            class="px-7 pt-10"
        >
            <div class="space-y-6 pl-16">
                <p class="text-xl">Source</p>
                <div class="h-16 rounded-md border"></div>
                <div class="h-16 rounded-md border"></div>
            </div>
        </Skeleton>
    {:else if resourceQuery.isError}
        <Alert variant="error" class="m-7">
            <AlertDescription>
                Unable to load settings: {resourceQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <div class="flex flex-1 gap-12 px-7 pt-10">
            <!-- Railway's timeline: one icon per section on a thin vertical rule. -->
            <div
                class="relative flex min-w-0 max-w-[600px] flex-1 flex-col"
            >
                <div
                    class="absolute top-5 bottom-0 left-5 w-px bg-border"
                    aria-hidden="true"
                ></div>
                {#each visibleSections as section (section.id)}
                    <section
                        id="settings-{section.id}"
                        class="relative scroll-mt-20 pb-14 pl-16"
                        aria-labelledby="settings-{section.id}-title"
                    >
                        <span
                            class={[
                                "absolute top-0 left-0 flex size-10 items-center justify-center rounded-full border bg-card",
                                section.id === "danger"
                                    ? "text-destructive-foreground"
                                    : "text-muted-foreground",
                            ]}
                            aria-hidden="true"
                        >
                            <section.icon class="size-4" />
                        </span>
                        {#if section.id !== "danger"}
                            <h3
                                id="settings-{section.id}-title"
                                class="flex h-10 items-center text-xl text-muted-foreground"
                            >
                                {section.title}
                            </h3>
                        {:else}
                            <h3
                                id="settings-{section.id}-title"
                                class="sr-only"
                            >
                                {section.title}
                            </h3>
                        {/if}
                        <div
                            class={[
                                "space-y-8",
                                section.id === "danger"
                                    ? "pt-2"
                                    : "pt-6",
                            ]}
                        >
                            {@render body(section.id)}
                        </div>
                    </section>
                {:else}
                    <p class="pl-16 text-sm text-muted-foreground">
                        No settings match "{filter.current}".
                    </p>
                {/each}
            </div>

            <!-- Railway's section rail, only where the panel is wide enough. -->
            <nav
                class="sticky top-24 hidden h-fit w-36 shrink-0 @3xl:block"
                aria-label="Settings sections"
            >
                <ul class="space-y-3 text-sm text-muted-foreground">
                    {#each visibleSections as section (section.id)}
                        <li>
                            <button
                                type="button"
                                class="transition-colors hover:text-foreground"
                                onclick={() => jump(section.id)}
                            >
                                {section.title}
                            </button>
                        </li>
                    {/each}
                </ul>
            </nav>
        </div>
    {/if}
</div>

{#if isBucket}
    <BucketLimitDialog
        projectId={resource.projectId}
        resourceId={resource.id}
        {bucket}
        bind:open={
            () => limitDialog.current,
            (open) => void limitDialog.set(open)
        }
    />
{/if}

<CanvasSourceDialog
    bind:open={sourceDialogOpen}
    {source}
    busy={git.pending}
    onsubmit={(next) => git.run("source", next)}
/>

{#if ingressDialog}
    <CanvasIngressDialog
        mode={ingressDialog.mode}
        entry={ingressDialog.entry}
        entries={ingressEntries}
        services={ingress?.services ?? []}
        compose={draftCompose}
        busy={savingIngress}
        onsubmit={saveIngress}
        onclose={() => (ingressDialog = null)}
    />
{/if}

<ConfirmDialog
    bind:open={
        () => ingressRemoval !== null,
        (open) => {
            if (!open) ingressRemoval = null;
        }
    }
    title="Remove {ingressRemoval
        ? ingressLabel(ingressRemoval)
        : 'ingress'}?"
    description="It is removed from the Compose draft and stops being published on the next deploy."
    confirmLabel="Remove"
    onconfirm={() => {
        if (ingressRemoval) void removeIngress(ingressRemoval);
        ingressRemoval = null;
    }}
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
