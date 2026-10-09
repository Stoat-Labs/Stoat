<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { beforeNavigate, goto } from "$app/navigation";
    import { page } from "$app/state";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import IngressRouteFlow from "$lib/components/shared/ingress-route-flow.svelte";
    import IngressRoutesListView from "$lib/components/ingress/ingress-routes-list.svelte";
    import IngressEntryDialog, {
        type DialogKind,
    } from "$lib/components/ingress/ingress-entry-dialog.svelte";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Container from "@lucide/svelte/icons/container";
    import Globe from "@lucide/svelte/icons/globe";
    import {
        parseIngressCompose,
        removeIngressFromCompose,
        removeServiceCaddy,
        type CaddyIngress,
        type HostIngress,
        type HttpIngress,
        type IngressEntry,
    } from "@stoat/workflows/ingress";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { onDestroy, untrack } from "svelte";
    import { z } from "zod";
    import { Debounced } from "runed";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    const readOnly = $derived(project?.isInternal === true);

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: projectId.length > 0 && resourceId.length > 0,
        }),
    );

    const resource = $derived(resourceQuery.data);

    let compose = $state("");

    const debouncedCompose = new Debounced(() => compose, 800);

    let loadedResourceId = $state("");

    let savedSpec = $state<string | null>(null);

    type SavedSource = {
        connectionId: string;
        repositoryUrl: string;
        branch: string;
        path: string;
        revision: string;
    };

    let savedSource = $state<SavedSource | null>(null);

    function sourceOf(resource: {
        gitConnectionId: string | null;
        gitSource: Omit<SavedSource, "connectionId"> | null;
    }): SavedSource | null {
        if (!resource.gitConnectionId || !resource.gitSource)
            return null;

        return {
            connectionId: resource.gitConnectionId,
            ...resource.gitSource,
        };
    }

    let generation = 0;

    let active = true;

    const isDirty = $derived(compose !== (savedSpec ?? ""));

    // Leaving with unsaved edits saves them first, then continues, so nothing is lost.
    // Closing or reloading the tab cannot wait for a save, so the browser asks instead.
    let resumedTo = "";

    beforeNavigate((navigation) => {
        // The navigation this guard resumes after saving; query state may still read busy.
        if (navigation.to?.url.href === resumedTo) return;

        if (!saveMutation.isPending && !isDirty) return;
        navigation.cancel();

        if (
            navigation.willUnload ||
            saveMutation.isPending ||
            !navigation.to
        )
            return;
        const target = navigation.to.url;
        void saveNow().then((saved) => {
            if (!saved) return;
            resumedTo = target.href;
            void goto(target);
        });
    });

    onDestroy(() => {
        active = false;
        debouncedCompose.cancel();
    });

    $effect(() => {
        const identity = `${projectId}/${resourceId}`;
        untrack(() => {
            if (identity) generation++;
            debouncedCompose.cancel();
            loadedResourceId = "";
            compose = "";
            savedSpec = null;
            savedSource = null;
            saveMutation.reset();
            actionError = "";
        });
    });

    $effect(() => {
        const current = resource;

        if (!current || current.id !== resourceId) return;
        untrack(() => {
            if (loadedResourceId !== current.id) {
                loadedResourceId = current.id;
                compose = current.draftSpec ?? "";
                savedSpec = current.draftSpec;
                savedSource = sourceOf(current);
                debouncedCompose.setImmediately(compose);
                saveMutation.reset();
            } else if (!isDirty && !saveMutation.isPending) {
                compose = current.draftSpec ?? "";
                savedSpec = current.draftSpec;
                savedSource = sourceOf(current);
                debouncedCompose.setImmediately(compose);
            }
        });
    });

    const saveMutation = createMutation(() =>
        orpc.resources.updateComposeSpec.mutationOptions({
            onSuccess: (updated, input) => {
                if (
                    active &&
                    projectId === input.projectId &&
                    resourceId === input.resourceId &&
                    loadedResourceId === updated.id
                ) {
                    savedSpec = updated.draftSpec;
                    savedSource = sourceOf(updated);
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: {
                            projectId: input.projectId,
                            resourceId: input.resourceId,
                        },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getContainers.key({
                        input: {
                            projectId: input.projectId,
                            resourceId: input.resourceId,
                        },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
        }),
    );

    type Snapshot = ReturnType<typeof parseIngressCompose>;

    const envSchema = z
        .object({ env: z.string().catch("") })
        .catch({ env: "" });

    const envText = $derived(envSchema.parse(resource?.settings).env);

    const snapshot = $derived.by((): Snapshot | null => {
        if (!compose.trim())
            return {
                services: [],
                entries: [],
                caddyRoutes: [],
                issues: [],
            };

        try {
            return parseIngressCompose(compose, envText);
        } catch {
            return null;
        }
    });

    const services = $derived(snapshot?.services ?? []);

    const entries = $derived(snapshot?.entries ?? []);

    const issues = $derived(snapshot?.issues ?? []);

    const httpEntries = $derived.by(() => {
        const list: HttpIngress[] = [];

        for (const entry of entries) {
            if (entry.kind === "http") list.push(entry);
        }

        return list;
    });

    const hostEntries = $derived.by(() => {
        const list: HostIngress[] = [];

        for (const entry of entries) {
            if (entry.kind === "host") list.push(entry);
        }

        return list;
    });

    const caddyEntries = $derived.by(() => {
        const list: CaddyIngress[] = [];

        for (const entry of entries) {
            if (entry.kind === "caddy") list.push(entry);
        }

        return list;
    });

    const caddyRoutes = $derived(snapshot?.caddyRoutes ?? []);

    /** Caddy-routed items grouped by host; host-only services skip the diagram. */
    type RouteItem = {
        key: string;
        host: string | null;
        service: string;
        path: string;
        port?: number;
    };

    type HostGroup = {
        host: string | null;
        items: RouteItem[];
    };

    const hostGroups = $derived.by(() => {
        const items: RouteItem[] = [];

        for (const entry of entries) {
            if (entry.kind === "http") {
                items.push({
                    key: `h:${entry.service}:${entry.raw}`,
                    host: entry.hostname,
                    service: entry.service,
                    path: "/",
                    port: entry.containerPort,
                });
            }
        }

        for (const route of caddyRoutes) {
            items.push({
                key: `c:${route.serviceName}:${route.host}:${route.path ?? ""}:${route.containerPort ?? ""}`,
                host: route.host,
                service: route.upstreamService,
                path: route.path ?? "/",
                port: route.containerPort,
            });
        }

        for (const entry of entries) {
            if (entry.kind !== "caddy") continue;

            let routed = false;

            for (const route of caddyRoutes) {
                if (route.serviceName === entry.service)
                    routed = true;
            }

            if (!routed) {
                items.push({
                    key: `o:${entry.service}`,
                    host: null,
                    service: entry.service,
                    path: "custom",
                });
            }
        }

        const groups = new Map<string, HostGroup>();

        for (const item of items) {
            const key = item.host ?? "";

            const group = groups.get(key) ?? {
                host: item.host,
                items: [],
            };

            group.items.push(item);
            groups.set(key, group);
        }

        for (const group of groups.values()) {
            group.items.sort((a, b) => {
                if (a.path === b.path) return 0;

                if (a.path === "/") return -1;

                if (b.path === "/") return 1;

                return a.path.localeCompare(b.path);
            });
        }

        return [...groups.values()].sort((a, b) => {
            if (a.host === null) return 1;

            if (b.host === null) return -1;

            return a.host.localeCompare(b.host);
        });
    });

    // The ingress being added (`entry` is null) or edited; null while the dialog is closed.
    let dialog = $state<{
        kind: DialogKind;
        entry: IngressEntry | null;
    } | null>(null);

    let actionError = $state("");

    /** Saves the Compose text without waiting for the autosave delay; false if it failed. */
    async function saveNow() {
        if (readOnly || loadedResourceId !== resourceId) return false;
        debouncedCompose.cancel();

        try {
            await saveMutation.mutateAsync({
                projectId,
                resourceId,
                spec: compose,
                expectedSpec: savedSpec,
                expectedSource: savedSource
                    ? { ...savedSource }
                    : null,
            });

            return true;
        } catch {
            // The page shows the save error.
            return false;
        }
    }

    // Autosave the draft after edits instead of a save button.
    $effect(() => {
        const target = debouncedCompose.current;
        const debouncePending = debouncedCompose.pending;
        const currentText = compose;
        const baseline = savedSpec;
        const baselineSource = savedSource;
        const loaded = loadedResourceId;
        const pid = projectId;
        const rid = resourceId;
        const valid = snapshot !== null;

        if (debouncePending) return;

        if (currentText !== target) return;

        if (target === (baseline ?? "")) return;

        if (!valid || saveMutation.isPending) return;

        if (readOnly || !pid || !rid || loaded !== rid) return;

        untrack(() => {
            actionError = "";
            saveMutation.mutate({
                projectId: pid,
                resourceId: rid,
                spec: target,
                expectedSpec: baseline,
                expectedSource: baselineSource
                    ? { ...baselineSource }
                    : null,
            });
        });
    });

    // A removal waiting for confirmation; `edit` returns the Compose text without it.
    let removal = $state<{
        description: string;
        edit: () => string;
    } | null>(null);

    let removalOpen = $state(false);

    function deleteEntry(entry: HttpIngress | HostIngress) {
        removal = {
            description: `Remove "${entry.raw}" from service "${entry.service}"? The Compose file will be updated.`,
            edit: () =>
                removeIngressFromCompose(
                    compose,
                    entry.service,
                    entry.raw,
                ),
        };
        removalOpen = true;
    }

    function deleteCaddy(entry: CaddyIngress) {
        removal = {
            description: `Remove the custom x-caddy config from service "${entry.service}"? The Compose file will be updated.`,
            edit: () => removeServiceCaddy(compose, entry.service),
        };
        removalOpen = true;
    }

    function confirmRemoval() {
        if (!removal) return;

        try {
            compose = removal.edit();
            actionError = "";
        } catch (cause) {
            actionError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }

        removalOpen = false;
    }
</script>

<svelte:head>
    <title>Ingress / {resource?.name ?? "Resource"} / Stoat</title>
</svelte:head>

<div class="flex w-full flex-col gap-6 pt-6 xl:min-h-0 xl:flex-1">
    {#if projectQuery.isPending || resourceQuery.isPending}
        <Skeleton loading loading-label="Loading ingress">
            <div class="space-y-6">
                <Frame>
                    <FrameHeader>
                        <FrameTitle class="text-base">
                            <h2>Ingress</h2>
                        </FrameTitle>
                        <FrameDescription class="mt-1">
                            Publish services over HTTPS or TCP/UDP.
                        </FrameDescription>
                    </FrameHeader>
                    <FramePanel class="min-h-48" />
                </Frame>
            </div>
        </Skeleton>
    {:else if projectQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load project: {projectQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !project}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Container aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Project not found</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/projects">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to projects
                </Button>
            </EmptyContent>
        </Empty>
    {:else if resourceQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load resource: {resourceQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !resource}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Container aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Resource not found</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/projects/{projectId}">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to {project.name}
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        <div class="flex flex-wrap items-start justify-between gap-3">
            <!-- <div class="min-w-0">
                <h1 class="text-2xl font-semibold">Ingress</h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    Publish service ports through Caddy. Every change
                    edits the Compose file directly.
                </p>
            </div>

            <div class="flex flex-wrap items-center gap-2">
                <div class="text-sm" aria-live="polite">
                    {#if saveMutation.isError}
                        <Alert
                            variant="error"
                            class="w-auto px-2 py-1.5"
                        >
                            <AlertDescription>
                                Unable to save: {saveMutation.error
                                    .message}
                            </AlertDescription>
                        </Alert>
                    {:else if saveMutation.isPending}
                        <p class="text-muted-foreground">Saving...</p>
                    {:else if isDirty}
                        <p class="text-muted-foreground">
                            Unsaved Compose changes
                        </p>
                    {/if}
                </div>
                <Button
                    variant="secondary"
                    href="/projects/{projectId}/{resourceId}"
                >
                    Compose editor
                </Button>
                {#if readOnly}
                    <Badge variant="secondary">System-managed</Badge>
                {/if}
            </div>
         -->
        </div>

        {#if snapshot === null}
            <Alert variant="error">
                <AlertDescription>
                    The Compose draft is not valid YAML. Fix it in the
                    Compose editor before managing ingress.
                </AlertDescription>
            </Alert>
        {:else}
            <Frame
                role="region"
                aria-labelledby="ingress-flow-heading"
            >
                <FrameHeader class="shrink-0">
                    <FrameTitle class="text-base">
                        <h2 id="ingress-flow-heading">
                            Traffic flow
                        </h2>
                    </FrameTitle>
                    <FrameDescription class="mt-1">
                        {#if entries.length === 0}
                            Nothing is published yet. HTTPS goes
                            through Caddy; host ports bypass it.
                        {:else if caddyRoutes.length > 0}
                            {httpEntries.length} HTTPS · {hostEntries.length}
                            host · {caddyRoutes.length} custom routes
                        {:else}
                            {httpEntries.length} HTTPS · {hostEntries.length}
                            host · {caddyEntries.length} custom
                        {/if}
                    </FrameDescription>
                </FrameHeader>
                <FramePanel class="overflow-hidden p-0">
                    {#if entries.length === 0}
                        <Empty
                            class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                        >
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <Globe aria-hidden="true" />
                                </EmptyMedia>
                                <EmptyDescription>
                                    No published ports. Add an ingress
                                    below to expose a service.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else}
                        {#each hostGroups as group, groupIndex (group.host ?? "default")}
                            <div
                                class={groupIndex > 0
                                    ? "border-t border-border"
                                    : ""}
                            >
                                <IngressRouteFlow
                                    host={group.host}
                                    items={group.items}
                                />
                            </div>
                        {/each}
                        {#if hostEntries.length > 0}
                            <ul
                                class="space-y-1 border-t border-border px-5 py-3 font-mono text-xs text-muted-foreground"
                            >
                                {#each hostEntries as entry (`${entry.service}-${entry.raw}`)}
                                    <li
                                        class="truncate"
                                        title={entry.raw}
                                    >
                                        {entry.bind ??
                                            "*"}:{entry.hostPort}
                                        → {entry.service}:{entry.containerPort}
                                        ({entry.protocol}) · bypasses
                                        Caddy
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                    {/if}
                </FramePanel>
            </Frame>

            {#if issues.length > 0}
                <Alert variant="warning">
                    <AlertDescription>
                        <ul class="list-disc space-y-1 ps-4">
                            {#each issues as issue (`${issue.service}-${issue.message}`)}
                                <li>
                                    <span class="font-medium">
                                        {issue.service}:
                                    </span>
                                    {issue.message}
                                </li>
                            {/each}
                        </ul>
                    </AlertDescription>
                </Alert>
            {/if}

            {#if actionError}
                <Alert variant="error">
                    <AlertDescription>
                        {actionError}
                    </AlertDescription>
                </Alert>
            {/if}

            <IngressRoutesListView
                {entries}
                {caddyRoutes}
                {services}
                {readOnly}
                disabled={loadedResourceId !== resourceId}
                onadd={() => (dialog = { kind: "http", entry: null })}
                onedit={(entry) =>
                    (dialog = { kind: entry.kind, entry })}
                onremoveentry={deleteEntry}
                onremovecaddy={deleteCaddy}
            />
        {/if}
    {/if}
</div>

{#if dialog}
    <IngressEntryDialog
        kind={dialog.kind}
        entry={dialog.entry}
        {entries}
        {services}
        {compose}
        onapply={(next) => (compose = next)}
        onclose={() => (dialog = null)}
    />
{/if}

<ConfirmDialog
    bind:open={removalOpen}
    title="Remove ingress?"
    description={removal?.description ?? ""}
    confirmLabel="Remove"
    onconfirm={confirmRemoval}
/>
