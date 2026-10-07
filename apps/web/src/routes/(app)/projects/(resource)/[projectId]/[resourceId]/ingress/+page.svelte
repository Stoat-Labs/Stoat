<script lang="ts">
    import { beforeNavigate } from "$app/navigation";
    import { page } from "$app/state";
    import {
        Alert,
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
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Field, FieldError } from "$lib/components/ui/field";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Separator } from "$lib/components/ui/separator";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import IngressRouteFlow from "$lib/components/shared/ingress-route-flow.svelte";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/api/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import Container from "@lucide/svelte/icons/container";
    import Globe from "@lucide/svelte/icons/globe";
    import Network from "@lucide/svelte/icons/network";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Plus from "@lucide/svelte/icons/plus";
    import Server from "@lucide/svelte/icons/server";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
    import {
        addIngressToCompose,
        bindError,
        buildHostSpec,
        buildHttpSpec,
        decomposePortSpec,
        hostnameError,
        parseIngressCompose,
        portTextError,
        removeIngressFromCompose,
        removeServiceCaddy,
        setServiceCaddy,
        type CaddyIngress,
        type CaddyRoute,
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

    let savedSource = $state<{
        connectionId: string;
        repositoryUrl: string;
        branch: string;
        path: string;
        revision: string;
    } | null>(null);

    let generation = 0;

    let active = true;

    const isDirty = $derived(compose !== (savedSpec ?? ""));

    beforeNavigate((navigation) => {
        if (saveMutation.isPending || isDirty) {
            if (
                navigation.willUnload ||
                saveMutation.isPending ||
                !window.confirm("Discard unsaved Compose edits?")
            )
                navigation.cancel();
        }
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
                savedSource =
                    current.gitConnectionId && current.gitSource
                        ? {
                              connectionId: current.gitConnectionId,
                              ...current.gitSource,
                          }
                        : null;
                debouncedCompose.setImmediately(compose);
                saveMutation.reset();
            } else if (!isDirty && !saveMutation.isPending) {
                compose = current.draftSpec ?? "";
                savedSpec = current.draftSpec;
                savedSource =
                    current.gitConnectionId && current.gitSource
                        ? {
                              connectionId: current.gitConnectionId,
                              ...current.gitSource,
                          }
                        : null;
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
                    savedSource =
                        updated.gitConnectionId && updated.gitSource
                            ? {
                                  connectionId:
                                      updated.gitConnectionId,
                                  ...updated.gitSource,
                              }
                            : null;
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

    type DialogKind = "http" | "host" | "caddy";

    let dialogOpen = $state(false);

    let dialogKind = $state<DialogKind>("http");

    let editingRaw = $state<string | null>(null);

    let editingCaddyService = $state<string | null>(null);

    let dialogService = $state("");

    let dialogHostname = $state("");

    let dialogContainerPort = $state("");

    let dialogHttpProtocol = $state("https");

    let dialogBind = $state("");

    let dialogHostPort = $state("");

    let dialogHostContainerPort = $state("");

    let dialogHostProtocol = $state("tcp");

    let dialogCaddy = $state("");

    let dialogError = $state("");

    let actionError = $state("");

    let editingService = $state<string | null>(null);

    type ListRow =
        | { kind: "port"; entry: HttpIngress | HostIngress }
        | {
              kind: "caddy-route";
              entry: CaddyIngress;
              route: CaddyRoute;
          }
        | { kind: "caddy"; entry: CaddyIngress };

    const listRows = $derived.by(() => {
        const rows: ListRow[] = [];

        for (const entry of entries) {
            if (entry.kind !== "caddy") {
                rows.push({ kind: "port", entry });

                continue;
            }

            let matched = false;

            for (const route of caddyRoutes) {
                if (route.serviceName !== entry.service) continue;

                matched = true;
                rows.push({ kind: "caddy-route", entry, route });
            }

            if (!matched) rows.push({ kind: "caddy", entry });
        }

        return rows;
    });

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

    function resetDialog() {
        dialogService = services[0] ?? "";
        dialogHostname = "";
        dialogContainerPort = "";
        dialogHttpProtocol = "https";
        dialogBind = "";
        dialogHostPort = "";
        dialogHostContainerPort = "";
        dialogHostProtocol = "tcp";
        dialogCaddy = "";
        dialogError = "";
        editingRaw = null;
        editingCaddyService = null;
        editingService = null;
    }

    function openAdd(kind: DialogKind) {
        resetDialog();
        dialogKind = kind;
        dialogOpen = true;
    }

    function openEditEntry(entry: IngressEntry) {
        resetDialog();

        if (entry.kind === "http") {
            dialogKind = "http";
            dialogService = entry.service;
            const rawParts = decomposePortSpec(entry.raw);

            const rawHttp =
                rawParts?.kind === "http" ? rawParts : null;

            dialogHostname =
                rawHttp?.hostname ?? entry.hostname ?? "";
            dialogContainerPort =
                rawHttp?.portText ?? String(entry.containerPort);
            dialogHttpProtocol =
                rawHttp?.protocol === "http" ||
                rawHttp?.protocol === "https"
                    ? rawHttp.protocol
                    : entry.protocol;
            editingRaw = entry.raw;
            editingService = entry.service;
        } else if (entry.kind === "host") {
            dialogKind = "host";
            dialogService = entry.service;
            const rawParts = decomposePortSpec(entry.raw);

            const rawHost =
                rawParts?.kind === "host" ? rawParts : null;

            dialogBind = rawHost?.bind ?? entry.bind ?? "";
            dialogHostPort =
                rawHost?.hostPortText ?? String(entry.hostPort);
            dialogHostContainerPort =
                rawHost?.containerPortText ??
                String(entry.containerPort);
            dialogHostProtocol =
                rawHost?.protocol === "tcp" ||
                rawHost?.protocol === "udp"
                    ? rawHost.protocol
                    : entry.protocol;
            editingRaw = entry.raw;
            editingService = entry.service;
        } else {
            dialogKind = "caddy";
            dialogService = entry.service;
            dialogCaddy = entry.fileRef ? "" : entry.caddy;
            editingCaddyService = entry.service;
        }

        dialogOpen = true;
    }

    function serviceHasCaddy(serviceName: string): boolean {
        for (const entry of entries) {
            if (
                entry.kind === "caddy" &&
                entry.service === serviceName
            )
                return true;
        }

        return false;
    }

    function hostnameTaken(hostname: string): boolean {
        for (const entry of entries) {
            if (entry.kind !== "http" || entry.hostname === null)
                continue;

            if (
                entry.hostname.toLowerCase() ===
                    hostname.toLowerCase() &&
                entry.raw !== editingRaw
            )
                return true;
        }

        return false;
    }

    function rawTaken(serviceName: string, raw: string): boolean {
        for (const entry of entries) {
            if (
                (entry.kind === "http" || entry.kind === "host") &&
                entry.service === serviceName &&
                entry.raw === raw &&
                raw !== editingRaw
            )
                return true;
        }

        return false;
    }

    function applyEdit(serviceName: string, spec: string) {
        const fromService = editingService ?? serviceName;

        if (
            editingRaw !== null &&
            editingRaw === spec &&
            fromService === serviceName
        )
            return;

        let next = compose;

        if (editingRaw !== null)
            next = removeIngressFromCompose(
                next,
                fromService,
                editingRaw,
            );

        compose = addIngressToCompose(next, serviceName, spec);
    }

    function submitDialog(event: Event) {
        event.preventDefault();
        dialogError = "";

        if (!dialogService) {
            dialogError = "Choose a service first.";

            return;
        }

        try {
            if (dialogKind === "http") {
                const hostname = dialogHostname.trim();
                const portText = dialogContainerPort.trim();

                const protocol =
                    dialogHttpProtocol === "http" ? "http" : "https";

                const rawParts =
                    editingRaw === null
                        ? null
                        : decomposePortSpec(editingRaw);

                const rawHttp =
                    rawParts?.kind === "http" ? rawParts : null;

                if (
                    rawHttp !== null &&
                    hostname === (rawHttp.hostname ?? "") &&
                    portText === rawHttp.portText &&
                    protocol === rawHttp.protocol
                ) {
                    if (
                        dialogService !== editingService &&
                        serviceHasCaddy(dialogService)
                    ) {
                        dialogError = `Service "${dialogService}" uses x-caddy and cannot also publish http/https ports. Remove the custom Caddy config first.`;

                        return;
                    }

                    applyEdit(dialogService, editingRaw ?? "");

                    return;
                }

                if (
                    hostname.includes("$") ||
                    portText.includes("$")
                ) {
                    dialogError =
                        "Changed values with variables can't be validated here. Keep the entry unchanged or edit the Compose file directly.";

                    return;
                }

                if (hostname !== "") {
                    const issue = hostnameError(hostname);

                    if (issue !== null) {
                        dialogError = issue;

                        return;
                    }

                    if (hostnameTaken(hostname)) {
                        dialogError = `Hostname "${hostname}" is already published. Hostnames must be unique.`;

                        return;
                    }
                }

                const portIssue = portTextError(portText);

                if (portIssue !== null) {
                    dialogError = portIssue;

                    return;
                }

                if (serviceHasCaddy(dialogService)) {
                    dialogError = `Service "${dialogService}" uses x-caddy and cannot also publish http/https ports. Remove the custom Caddy config first.`;

                    return;
                }

                const spec = buildHttpSpec(
                    hostname === "" ? null : hostname,
                    Number(portText),
                    protocol,
                );

                if (rawTaken(dialogService, spec)) {
                    dialogError =
                        "That publish entry already exists on this service.";

                    return;
                }

                applyEdit(dialogService, spec);
            } else if (dialogKind === "host") {
                const bind = dialogBind.trim();
                const hostText = dialogHostPort.trim();
                const containerText = dialogHostContainerPort.trim();

                const protocol =
                    dialogHostProtocol === "udp" ? "udp" : "tcp";

                const rawParts =
                    editingRaw === null
                        ? null
                        : decomposePortSpec(editingRaw);

                const rawHost =
                    rawParts?.kind === "host" ? rawParts : null;

                if (
                    rawHost !== null &&
                    bind === (rawHost.bind ?? "") &&
                    hostText === rawHost.hostPortText &&
                    containerText === rawHost.containerPortText &&
                    protocol === rawHost.protocol
                ) {
                    applyEdit(dialogService, editingRaw ?? "");

                    return;
                }

                if (
                    bind.includes("$") ||
                    hostText.includes("$") ||
                    containerText.includes("$")
                ) {
                    dialogError =
                        "Changed values with variables can't be validated here. Keep the entry unchanged or edit the Compose file directly.";

                    return;
                }

                if (bind !== "") {
                    const issue = bindError(bind);

                    if (issue !== null) {
                        dialogError = issue;

                        return;
                    }
                }

                const hostIssue = portTextError(hostText);

                if (hostIssue !== null) {
                    dialogError = `Host port: ${hostIssue}`;

                    return;
                }

                const containerIssue = portTextError(containerText);

                if (containerIssue !== null) {
                    dialogError = `Container port: ${containerIssue}`;

                    return;
                }

                const spec = buildHostSpec(
                    bind === "" ? null : bind,
                    Number(hostText),
                    Number(containerText),
                    protocol,
                );

                if (rawTaken(dialogService, spec)) {
                    dialogError =
                        "That publish entry already exists on this service.";

                    return;
                }

                applyEdit(dialogService, spec);
            } else {
                if (dialogCaddy.trim() === "") {
                    dialogError = "Paste a Caddyfile first.";

                    return;
                }

                if (
                    editingCaddyService === null &&
                    entries.some(
                        (entry) =>
                            entry.kind === "http" &&
                            entry.service === dialogService,
                    )
                ) {
                    dialogError = `Service "${dialogService}" already publishes http/https ports. x-caddy cannot be combined with them.`;

                    return;
                }

                compose = setServiceCaddy(
                    compose,
                    dialogService,
                    dialogCaddy,
                );
            }
        } catch (cause) {
            dialogError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";

            return;
        }

        dialogOpen = false;
    }

    function deleteEntry(entry: HttpIngress | HostIngress) {
        if (
            !window.confirm(
                `Remove "${entry.raw}" from service "${entry.service}"? The Compose file will be updated.`,
            )
        )
            return;

        try {
            compose = removeIngressFromCompose(
                compose,
                entry.service,
                entry.raw,
            );
            actionError = "";
        } catch (cause) {
            actionError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }
    }

    function deleteCaddy(entry: CaddyIngress) {
        if (
            !window.confirm(
                `Remove the custom x-caddy config from service "${entry.service}"? The Compose file will be updated.`,
            )
        )
            return;

        try {
            compose = removeServiceCaddy(compose, entry.service);
            actionError = "";
        } catch (cause) {
            actionError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }
    }

    const dialogTitle = $derived(
        editingRaw !== null || editingCaddyService !== null
            ? "Edit ingress"
            : dialogKind === "http"
              ? "Add HTTPS ingress"
              : dialogKind === "host"
                ? "Add TCP/UDP port"
                : "Add custom Caddy",
    );
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

            <Frame
                role="region"
                aria-labelledby="ingress-list-heading"
            >
                <FrameHeader
                    class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
                >
                    <div class="min-w-0">
                        <FrameTitle class="text-base">
                            <h2 id="ingress-list-heading">
                                Published routes
                            </h2>
                        </FrameTitle>
                        <FrameDescription class="mt-1">
                            Backed by x-ports and x-caddy in the
                            Compose file.
                        </FrameDescription>
                    </div>
                    {#if !readOnly}
                        <Button
                            size="sm"
                            disabled={services.length === 0 ||
                                loadedResourceId !== resourceId}
                            onclick={() => openAdd("http")}
                        >
                            <Plus class="size-4" aria-hidden="true" />
                            Create ingress
                        </Button>
                    {/if}
                </FrameHeader>
                <FramePanel
                    class="max-h-96 overflow-y-auto p-0 xl:max-h-none"
                >
                    {#if services.length === 0}
                        <Empty
                            class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                        >
                            <EmptyHeader>
                                <EmptyDescription>
                                    This Compose file has no services
                                    yet. Add a service in the Compose
                                    editor first.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else if entries.length === 0}
                        <Empty
                            class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                        >
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <Globe aria-hidden="true" />
                                </EmptyMedia>
                                <EmptyDescription>
                                    No ingress yet. HTTPS entries look
                                    like
                                    <span class="font-mono">
                                        example.com:8000/https
                                    </span>
                                    ; host ports end with
                                    <span class="font-mono">
                                        @host
                                    </span>
                                    .
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else}
                        <ul>
                            {#each listRows as row, index (row.kind === "port" ? `${row.entry.service}-${row.entry.raw}` : row.kind === "caddy-route" ? `caddy-${row.entry.service}-${row.route.host}-${row.route.path ?? ""}` : `caddy-${row.entry.service}`)}
                                <li class="min-w-0">
                                    {#if index > 0}<Separator />{/if}
                                    <div
                                        class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 p-3"
                                    >
                                        <span
                                            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                        >
                                            {#if row.kind === "port" && row.entry.kind === "http"}
                                                <Globe
                                                    class="size-5"
                                                    aria-hidden="true"
                                                />
                                            {:else if row.kind === "port"}
                                                <Network
                                                    class="size-5"
                                                    aria-hidden="true"
                                                />
                                            {:else}
                                                <Server
                                                    class="size-5"
                                                    aria-hidden="true"
                                                />
                                            {/if}
                                        </span>
                                        <div class="min-w-0 flex-1">
                                            {#if row.kind === "port" && row.entry.kind === "http"}
                                                <h3
                                                    class="truncate font-mono text-sm font-medium leading-5"
                                                    title={row.entry
                                                        .raw}
                                                >
                                                    {row.entry
                                                        .protocol}://{row
                                                        .entry
                                                        .hostname ??
                                                        "<cluster-domain>"}
                                                    <span
                                                        class="text-muted-foreground"
                                                    >
                                                        <ArrowRight
                                                            class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                            aria-hidden="true"
                                                        />
                                                        {row.entry
                                                            .service}:{row
                                                            .entry
                                                            .containerPort}
                                                    </span>
                                                </h3>
                                                <p
                                                    class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                                >
                                                    {row.entry.raw}
                                                </p>
                                            {:else if row.kind === "port" && row.entry.kind === "host"}
                                                <h3
                                                    class="truncate font-mono text-sm font-medium leading-5"
                                                    title={row.entry
                                                        .raw}
                                                >
                                                    {row.entry.bind ??
                                                        "*"}:{row
                                                        .entry
                                                        .hostPort}
                                                    <span
                                                        class="text-muted-foreground"
                                                    >
                                                        <ArrowRight
                                                            class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                            aria-hidden="true"
                                                        />
                                                        {row.entry
                                                            .service}:{row
                                                            .entry
                                                            .containerPort}
                                                        ({row.entry
                                                            .protocol})
                                                    </span>
                                                </h3>
                                                <p
                                                    class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                                >
                                                    {row.entry.raw} · bypasses
                                                    Caddy
                                                </p>
                                            {:else if row.kind === "caddy-route"}
                                                <h3
                                                    class="truncate font-mono text-sm font-medium leading-5"
                                                >
                                                    <a
                                                        href={`${row.route.protocol}://${row.route.host}${row.route.path?.replace(/\*$/u, "") ?? ""}`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        class="underline decoration-muted-foreground underline-offset-2 hover:text-foreground"
                                                        title={`${row.route.protocol}://${row.route.host}${row.route.path ?? ""}`}
                                                    >
                                                        {row.route
                                                            .protocol}://{row
                                                            .route
                                                            .host}{row
                                                            .route
                                                            .path ??
                                                            ""}
                                                    </a>
                                                    <span
                                                        class="text-muted-foreground"
                                                    >
                                                        <ArrowRight
                                                            class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                            aria-hidden="true"
                                                        />
                                                        {row.route
                                                            .upstreamService}{row
                                                            .route
                                                            .containerPort ===
                                                        undefined
                                                            ? ""
                                                            : `:${row.route.containerPort}`}
                                                    </span>
                                                </h3>
                                                <p
                                                    class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                                    title={`x-caddy on ${row.entry.service}`}
                                                >
                                                    x-caddy on {row
                                                        .entry
                                                        .service}
                                                </p>
                                            {:else if row.kind === "caddy"}
                                                <h3
                                                    class="truncate text-sm font-medium leading-5"
                                                >
                                                    Custom Caddy ·
                                                    {row.entry
                                                        .service}
                                                </h3>
                                                <p
                                                    class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                                    title={row.entry
                                                        .fileRef
                                                        ? row.entry
                                                              .caddy
                                                        : row.entry.caddy.split(
                                                              "\n",
                                                          )[0]}
                                                >
                                                    {row.entry.fileRef
                                                        ? `File: ${row.entry.caddy.trim()}`
                                                        : (row.entry.caddy.split(
                                                              "\n",
                                                          )[0] ??
                                                          row.entry
                                                              .caddy)}
                                                </p>
                                            {/if}
                                        </div>
                                        <div
                                            class="flex shrink-0 flex-wrap items-center gap-1.5"
                                        >
                                            {#if row.kind === "port" && row.entry.kind === "http"}
                                                <Badge
                                                    variant="secondary"
                                                >
                                                    {row.entry
                                                        .service}
                                                </Badge>
                                                <Badge
                                                    variant={row.entry
                                                        .protocol ===
                                                    "https"
                                                        ? "success"
                                                        : "warning"}
                                                >
                                                    {row.entry
                                                        .protocol}
                                                </Badge>
                                            {:else if row.kind === "port" && row.entry.kind === "host"}
                                                <Badge
                                                    variant="secondary"
                                                >
                                                    {row.entry
                                                        .service}
                                                </Badge>
                                                <Badge
                                                    variant="outline"
                                                >
                                                    {row.entry
                                                        .protocol}
                                                </Badge>
                                            {:else if row.kind === "caddy-route"}
                                                {#if row.route.path}
                                                    <Badge
                                                        variant="outline"
                                                    >
                                                        {row.route
                                                            .path}
                                                    </Badge>
                                                {/if}
                                                <Badge
                                                    variant="secondary"
                                                >
                                                    {row.route
                                                        .upstreamService}
                                                </Badge>
                                                <Badge
                                                    variant={row.route
                                                        .protocol ===
                                                    "https"
                                                        ? "success"
                                                        : "warning"}
                                                >
                                                    {row.route
                                                        .protocol}
                                                </Badge>
                                            {:else if row.kind === "caddy"}
                                                <Badge
                                                    variant="secondary"
                                                >
                                                    {row.entry
                                                        .service}
                                                </Badge>
                                                {#if row.entry.fileRef}
                                                    <Badge
                                                        variant="warning"
                                                    >
                                                        <TriangleAlert
                                                            class="size-3"
                                                            aria-hidden="true"
                                                        />
                                                        File ref
                                                    </Badge>
                                                {:else}
                                                    <Badge
                                                        variant="outline"
                                                    >
                                                        x-caddy
                                                    </Badge>
                                                {/if}
                                            {/if}
                                            {#if !readOnly}
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={row.kind ===
                                                    "caddy"
                                                        ? `Edit custom Caddy for ${row.entry.service}`
                                                        : row.kind ===
                                                            "caddy-route"
                                                          ? `Edit Caddy routes for ${row.entry.service}`
                                                          : `Edit ${row.entry.raw}`}
                                                    disabled={loadedResourceId !==
                                                        resourceId}
                                                    onclick={() =>
                                                        openEditEntry(
                                                            row.entry,
                                                        )}
                                                >
                                                    <Pencil
                                                        class="size-4"
                                                        aria-hidden="true"
                                                    />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    aria-label={row.kind ===
                                                    "port"
                                                        ? `Remove ${row.entry.raw}`
                                                        : `Remove custom Caddy from ${row.entry.service}`}
                                                    disabled={loadedResourceId !==
                                                        resourceId}
                                                    onclick={() =>
                                                        row.kind ===
                                                        "port"
                                                            ? deleteEntry(
                                                                  row.entry,
                                                              )
                                                            : deleteCaddy(
                                                                  row.entry,
                                                              )}
                                                >
                                                    <Trash2
                                                        class="size-4"
                                                        aria-hidden="true"
                                                    />
                                                </Button>
                                            {/if}
                                        </div>
                                    </div>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </FramePanel>
            </Frame>
        {/if}
    {/if}
</div>

<Dialog
    bind:open={
        () => dialogOpen,
        (open) => {
            dialogOpen = open;
        }
    }
>
    <DialogContent class="sm:max-w-xl">
        <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
                {#if dialogKind === "http"}
                    Publishes a container port as HTTPS through Caddy:
                    [hostname:]port[/http|https].
                {:else if dialogKind === "host"}
                    Binds a container port to the host:
                    [bind:]host:container[/tcp|udp]@host. Bypasses
                    Caddy.
                {:else}
                    Custom Caddyfile for one service. Supports
                    {"{{upstreams 8000}}"} templates. Cannot mix with http/https
                    x-ports.
                {/if}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if dialogError}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>
                        {dialogError}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if editingRaw !== null && editingRaw.includes("$")}
                <p
                    class="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                    Uses Compose variables from this resource's
                    Variables — shown as written. Saving unchanged
                    keeps them.
                </p>
            {/if}
            <form
                id="ingress-form"
                method="POST"
                onsubmit={submitDialog}
                class="space-y-4"
            >
                {#if editingCaddyService === null}
                    <div class="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <Label for="ingress-kind" required>
                                Type
                            </Label>
                            <Select
                                value={dialogKind}
                                items={[
                                    {
                                        value: "http",
                                        label: "HTTPS ingress",
                                    },
                                    {
                                        value: "host",
                                        label: "TCP/UDP host port",
                                    },
                                    {
                                        value: "caddy",
                                        label: "Custom Caddy",
                                    },
                                ]}
                                disabled={editingRaw !== null}
                                onValueChange={(value) => {
                                    if (
                                        value === "http" ||
                                        value === "host" ||
                                        value === "caddy"
                                    )
                                        dialogKind = value;
                                }}
                            >
                                <SelectTrigger id="ingress-kind">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="http"
                                        label="HTTPS ingress"
                                    />
                                    <SelectItem
                                        value="host"
                                        label="TCP/UDP host port"
                                    />
                                    <SelectItem
                                        value="caddy"
                                        label="Custom Caddy"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <Label for="ingress-service" required>
                                Service
                            </Label>
                            <Select
                                value={dialogService}
                                items={services.map((name) => ({
                                    value: name,
                                    label: name,
                                }))}
                                onValueChange={(value) =>
                                    (dialogService = value ?? "")}
                            >
                                <SelectTrigger id="ingress-service">
                                    <SelectValue
                                        placeholder="Choose a service"
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    {#each services as name (name)}
                                        <SelectItem
                                            value={name}
                                            label={name}
                                        />
                                    {/each}
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>
                {/if}
                {#if dialogKind === "http" && editingCaddyService === null}
                    <Field>
                        <Label for="ingress-hostname">Hostname</Label>
                        <Input
                            id="ingress-hostname"
                            bind:value={dialogHostname}
                            placeholder="app.example.com (empty = cluster default)"
                            maxlength={253}
                            autocomplete="off"
                            spellcheck={false}
                        />
                        <p class="text-xs text-muted-foreground">
                            Point a DNS A record at your machines.
                            HTTPS certificates are automatic.
                        </p>
                    </Field>
                    <div class="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <Label
                                for="ingress-container-port"
                                required
                            >
                                Container port
                            </Label>
                            <Input
                                id="ingress-container-port"
                                bind:value={dialogContainerPort}
                                placeholder="8000"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if dialogContainerPort.trim() !== "" && portTextError(dialogContainerPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        dialogContainerPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label for="ingress-protocol">
                                Protocol
                            </Label>
                            <Select
                                value={dialogHttpProtocol}
                                items={[
                                    {
                                        value: "https",
                                        label: "https (default)",
                                    },
                                    {
                                        value: "http",
                                        label: "http",
                                    },
                                ]}
                                onValueChange={(value) =>
                                    (dialogHttpProtocol =
                                        value ?? "https")}
                            >
                                <SelectTrigger id="ingress-protocol">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="https"
                                        label="https (default)"
                                    />
                                    <SelectItem
                                        value="http"
                                        label="http"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>
                {:else if dialogKind === "host" && editingCaddyService === null}
                    <Field>
                        <Label for="ingress-bind">Bind address</Label>
                        <Input
                            id="ingress-bind"
                            bind:value={dialogBind}
                            placeholder="Empty = all interfaces"
                            autocomplete="off"
                            spellcheck={false}
                        />
                        {#if dialogBind.trim() !== "" && bindError(dialogBind.trim()) !== null}
                            <FieldError>
                                {bindError(dialogBind.trim())}
                            </FieldError>
                        {/if}
                        <p class="text-xs text-muted-foreground">
                            IP or CIDR, e.g. 127.0.0.1 or
                            192.168.76.0/24. Databases should stay
                            internal unless you need them outside.
                        </p>
                    </Field>
                    <div class="grid gap-4 sm:grid-cols-3">
                        <Field>
                            <Label for="ingress-host-port" required>
                                Host port
                            </Label>
                            <Input
                                id="ingress-host-port"
                                bind:value={dialogHostPort}
                                placeholder="5432"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if dialogHostPort.trim() !== "" && portTextError(dialogHostPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        dialogHostPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label
                                for="ingress-host-container-port"
                                required
                            >
                                Container port
                            </Label>
                            <Input
                                id="ingress-host-container-port"
                                bind:value={dialogHostContainerPort}
                                placeholder="5432"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if dialogHostContainerPort.trim() !== "" && portTextError(dialogHostContainerPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        dialogHostContainerPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label for="ingress-host-protocol">
                                Protocol
                            </Label>
                            <Select
                                value={dialogHostProtocol}
                                items={[
                                    {
                                        value: "tcp",
                                        label: "tcp (default)",
                                    },
                                    { value: "udp", label: "udp" },
                                ]}
                                onValueChange={(value) =>
                                    (dialogHostProtocol =
                                        value ?? "tcp")}
                            >
                                <SelectTrigger
                                    id="ingress-host-protocol"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="tcp"
                                        label="tcp (default)"
                                    />
                                    <SelectItem
                                        value="udp"
                                        label="udp"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>
                {:else}
                    {#if editingCaddyService === null}
                        <Field>
                            <Label
                                for="ingress-caddy-service"
                                required
                            >
                                Service
                            </Label>
                            <Select
                                value={dialogService}
                                items={services.map((name) => ({
                                    value: name,
                                    label: name,
                                }))}
                                onValueChange={(value) =>
                                    (dialogService = value ?? "")}
                            >
                                <SelectTrigger
                                    id="ingress-caddy-service"
                                >
                                    <SelectValue
                                        placeholder="Choose a service"
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    {#each services as name (name)}
                                        <SelectItem
                                            value={name}
                                            label={name}
                                        />
                                    {/each}
                                </SelectContent>
                            </Select>
                        </Field>
                    {/if}
                    <Field>
                        <Label for="ingress-caddy" required>
                            Caddyfile
                            {#if editingCaddyService !== null}
                                · {editingCaddyService}
                            {/if}
                        </Label>
                        <Textarea
                            id="ingress-caddy"
                            bind:value={dialogCaddy}
                            rows={10}
                            maxlength={20000}
                            spellcheck={false}
                            placeholder={"example.com {\n\treverse_proxy {{upstreams 8000}}\n}"}
                            class="font-mono text-[13px]"
                        />
                        <p class="text-xs text-muted-foreground">
                            Verify with
                            <span class="font-mono">
                                uc caddy config
                            </span>
                            after deploying.
                        </p>
                    </Field>
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={() => (dialogOpen = false)}
            >
                Cancel
            </Button>
            <Button type="submit" form="ingress-form">
                <ArrowRight class="size-4" aria-hidden="true" />
                {editingRaw !== null || editingCaddyService !== null
                    ? "Apply to Compose"
                    : "Add to Compose"}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
