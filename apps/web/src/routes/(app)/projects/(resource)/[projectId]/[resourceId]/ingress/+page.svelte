<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
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
    import IngressTargetFlow from "$lib/components/shared/ingress-target-flow.svelte";
    import IngressRoutesListView from "$lib/components/ingress/ingress-routes-list.svelte";
    import IngressEntryDialog, {
        type DialogKind,
    } from "$lib/components/ingress/ingress-entry-dialog.svelte";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import { Badge } from "$lib/components/ui/badge";
    import { orpc } from "$lib/api/orpc";
    import { ComposeDraft } from "$lib/resources/compose-draft.svelte";
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
    import { createQuery } from "@tanstack/svelte-query";
    import * as v from "valibot";

    useHeaderActions(ingressStatus);

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

    let actionError = $state("");

    const draft = new ComposeDraft({
        projectId: () => projectId,
        resourceId: () => resourceId,
        resource: () => resource,
        readOnly: () => readOnly,
        busy: () => false,
        // Never autosave text the ingress parser cannot read.
        paused: () => snapshot === null,
        onSwitch: () => {
            actionError = "";
        },
    });

    type Snapshot = ReturnType<typeof parseIngressCompose>;

    const envSchema = v.fallback(
        v.object({ env: v.fallback(v.string(), "") }),
        { env: "" },
    );

    const envText = $derived(
        v.parse(envSchema, resource?.settings).env,
    );

    const snapshot = $derived.by((): Snapshot | null => {
        if (!draft.compose.trim())
            return {
                services: [],
                entries: [],
                caddyRoutes: [],
                issues: [],
            };

        try {
            return parseIngressCompose(draft.compose, envText);
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

    // A host whose only route is `/` has nothing to fan out, so hosts like that
    // collapse into one flow per upstream instead of repeating its node.
    const isRootOnly = (group: HostGroup) =>
        group.host !== null &&
        group.items.length === 1 &&
        group.items[0].path === "/";

    const fanOutGroups = $derived(
        hostGroups.filter((group) => !isRootOnly(group)),
    );

    const targetGroups = $derived.by(() => {
        const groups = new Map<
            string,
            { service: string; port?: number; hosts: string[] }
        >();

        for (const group of hostGroups) {
            if (!isRootOnly(group) || group.host === null) continue;

            const { service, port } = group.items[0];
            const key = `${service}:${port ?? ""}`;

            const target = groups.get(key) ?? {
                service,
                port,
                hosts: [],
            };

            target.hosts.push(group.host);
            groups.set(key, target);
        }

        return [...groups.values()];
    });

    // The ingress being added (`entry` is null) or edited; null while the dialog is closed.
    let dialog = $state<{
        kind: DialogKind;
        entry: IngressEntry | null;
    } | null>(null);

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
                    draft.compose,
                    entry.service,
                    entry.raw,
                ),
        };
        removalOpen = true;
    }

    function deleteCaddy(entry: CaddyIngress) {
        removal = {
            description: `Remove the custom x-caddy config from service "${entry.service}"? The Compose file will be updated.`,
            edit: () =>
                removeServiceCaddy(draft.compose, entry.service),
        };
        removalOpen = true;
    }

    function confirmRemoval() {
        if (!removal) return;

        try {
            draft.compose = removal.edit();
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

{#snippet ingressStatus()}
    <div
        class="flex flex-wrap items-center justify-end gap-2 text-sm"
        aria-live="polite"
    >
        {#if draft.save.isError}
            <span class="text-destructive-foreground" role="alert">
                Unable to save: {draft.save.error.message}
            </span>
        {:else if draft.save.isPending}
            <span class="text-muted-foreground">Saving…</span>
        {:else if draft.isDirty}
            <span class="text-muted-foreground">Unsaved changes</span>
        {/if}
        {#if readOnly}
            <Badge variant="secondary">System-managed</Badge>
        {/if}
    </div>
{/snippet}

<div class="flex w-full flex-col gap-6 pt-6 xl:min-h-0 xl:flex-1">
    {#if projectQuery.isPending || resourceQuery.isPending}
        <Skeleton loading label="Loading ingress">
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
        {#if snapshot === null}
            <Alert variant="error">
                <AlertDescription>
                    The Compose draft is not valid YAML. Fix it in the
                    Compose editor before managing ingress.
                </AlertDescription>
            </Alert>
        {:else}
            <!-- With nothing published, the routes list below explains how to add ingress. -->
            {#if entries.length > 0}
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
                            {#if caddyRoutes.length > 0}
                                {httpEntries.length} HTTPS · {hostEntries.length}
                                host · {caddyRoutes.length} custom routes
                            {:else}
                                {httpEntries.length} HTTPS · {hostEntries.length}
                                host · {caddyEntries.length} custom
                            {/if}
                        </FrameDescription>
                    </FrameHeader>
                    <FramePanel class="overflow-hidden p-0">
                        {#each targetGroups as target, targetIndex (`${target.service}:${target.port ?? ""}`)}
                            <div
                                class={targetIndex > 0
                                    ? "border-t border-border"
                                    : ""}
                            >
                                <IngressTargetFlow
                                    hosts={target.hosts}
                                    service={target.service}
                                    port={target.port}
                                />
                            </div>
                        {/each}
                        {#each fanOutGroups as group, groupIndex (group.host ?? "default")}
                            <div
                                class={groupIndex > 0 ||
                                targetGroups.length > 0
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
                    </FramePanel>
                </Frame>
            {/if}

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
                disabled={!draft.loaded}
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
        compose={draft.compose}
        onapply={(next) => (draft.compose = next)}
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
