<script lang="ts">
    import { page } from "$app/state";
    import { ago, dotClass, statusLabels, type ResourceStatus } from "$lib/components/home/project-overview-card.svelte";
    import CreateResourceDialog, { resourceFormParsers } from "$lib/components/projects/create-resource-dialog.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Avatar, AvatarFallback, AvatarImage } from "$lib/components/ui/avatar";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { buttonVariants } from "$lib/components/ui/button/button-variants";
    import { Card, CardDescription, CardHeader, CardTitle } from "$lib/components/ui/card";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Menu, MenuItem, MenuPopup, MenuTrigger } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { cn } from "$lib/utils";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
    import Container from "@lucide/svelte/icons/container";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import LayoutTemplate from "@lucide/svelte/icons/layout-template";
    import Plus from "@lucide/svelte/icons/plus";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { onMount } from "svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() => orpc.projects.getProject.queryOptions({ input: { projectId }, enabled: projectId.length > 0 }));

    const project = $derived(projectQuery.data);

    const isInternal = $derived(project?.isInternal === true);

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);

    let menuOpen = $state(false);

    const params = useQueryStates({ dialog: parseAsString, ...resourceFormParsers }, { shallow: true, scroll: false });

    let ready = $state(false);

    let now = $state(Date.now());

    let watchError = $state("");

    const summary = $derived.by(() => {
        const count = (match: (status: ResourceStatus) => boolean) =>
            resources.filter((resource) => match(resource.deploymentStatus)).length;

        return [
            { label: "deployed", dot: dotClass("ready"), count: count((s) => s === "ready") },
            { label: "deploying", dot: dotClass("running"), count: count((s) => s === "queued" || s === "running") },
            { label: "failed", dot: dotClass("failed"), count: count((s) => s === "failed") },
            { label: "not deployed", dot: dotClass(null), count: count((s) => s === null || s === "cancelled") },
        ].filter((item) => item.count > 0);
    });

    useHeaderActions(newResourceAction);

    onMount(() => {
        ready = true;
        const clock = setInterval(() => (now = Date.now()), 1_000);

        // Deployment row changes (not log lines) refresh every resource status on the page.
        const stop = subscribeToStream(
            (signal) => client.cluster.watchDeployments(undefined, { signal }),
            () => {
                watchError = "";
                void queryClient.invalidateQueries({ queryKey: orpc.resources.listResources.key() });
            },
            (error, reconnecting) => {
                watchError = `${error.message || "Live updates unavailable."}${reconnecting ? " Reconnecting..." : " Reload the page to reconnect."}`;
            },
        );

        return () => {
            ready = false;
            clearInterval(clock);
            stop();
        };
    });

    function statusVariant(status: ResourceStatus) {
        switch (status) {
            case "ready":
                return "success";
            case "failed":
                return "error";
            case "queued":
            case "running":
                return "warning";
            default:
                return "outline";
        }
    }

    // Mirrors the progress checkpoints set by the DeployResource worker.
    function deployStep(status: ResourceStatus, progress: number | null) {
        if (status === "queued") return "queued";

        if ((progress ?? 0) < 5) return "preparing";

        if ((progress ?? 0) < 10) return "planning";

        return "starting services";
    }

    function elapsed(from: Date | string, now: number) {
        const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));

        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }

    function openComposeDialog(source: "template" | null = null) {
        menuOpen = false;
        void params.set({ dialog: "create-resource", resourceName: null, resourceDescription: null, source, template: null });
    }
</script>

<svelte:head><title>{project?.name ?? "Project"} / Stoat</title></svelte:head>

{#snippet newResourceAction()}
    {#if project && !isInternal}
        <Menu bind:open={menuOpen}>
            <MenuTrigger
                class={buttonVariants({ size: "sm" })}
                disabled={!ready}
                aria-label="New resource"
            >
                <Plus class="size-4" aria-hidden="true" />
                New resource
                <ChevronsUpDown class="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
                <MenuItem onclick={() => openComposeDialog()}>
                    <Container aria-hidden="true" />
                    Compose
                </MenuItem>
                <MenuItem onclick={() => openComposeDialog("template")}>
                    <LayoutTemplate aria-hidden="true" />
                    Template
                </MenuItem>
            </MenuPopup>
        </Menu>
    {/if}
{/snippet}

<div class="w-full space-y-6 py-6">
    {#if projectQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load project: {projectQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !projectQuery.isPending && !project}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Boxes aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Project not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another organization.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/projects">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to projects
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        {#if watchError}
            <Alert variant="warning"><AlertDescription>{watchError}</AlertDescription></Alert>
        {/if}

        {#if isInternal}
            <Alert variant="info">
                <AlertDescription>
                    Stoat manages these internal services for this cluster. They're read-only here and only admins can see them.
                </AlertDescription>
            </Alert>
        {/if}

        {#if projectQuery.isPending || resourcesQuery.isPending}
            <Skeleton loading count={2} count-gap={12} loading-label="Loading resources">
                <Card class="p-4">
                    <CardHeader class="p-0">
                        <div class="flex items-center gap-3">
                            <span class="flex size-9 items-center justify-center rounded-lg border border-border">
                                <Container class="size-4" aria-hidden="true" />
                            </span>
                            <div class="min-w-0">
                                <CardTitle class="text-sm">Resource service</CardTitle>
                                <CardDescription class="text-xs">Compose service configuration</CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                </Card>
            </Skeleton>
        {:else if resourcesQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    Unable to load resources: {resourcesQuery.error.message}
                </AlertDescription>
            </Alert>
        {:else if resources.length === 0}
            <Empty class="rounded-xl border border-dashed border-border">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Container aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>No resources yet</EmptyTitle>
                    <EmptyDescription>
                        Create your first resource to get started.
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button size="sm" disabled={!ready} onclick={() => openComposeDialog()}>
                        <Plus class="size-4" aria-hidden="true" />
                        New resource
                    </Button>
                </EmptyContent>
            </Empty>
        {:else}
            <main class="space-y-4">
                <p class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground" aria-live="polite">
                    {#each summary as item (item.label)}
                        <span class="flex items-center gap-1.5">
                            <span class={cn("size-2 rounded-full", item.dot)} aria-hidden="true"></span>
                            <span class="font-medium text-foreground tabular-nums">{item.count}</span>
                            {item.label}
                        </span>
                    {/each}
                </p>
                <ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {#each resources as resource (resource.id)}
                        {@const status = resource.deploymentStatus}
                        {@const active = status === "queued" || status === "running"}
                        <li class="min-w-0">
                            <Card class="relative h-full gap-0 overflow-hidden p-4 transition-colors hover:bg-accent/50 focus-within:bg-accent/50">
                                <CardHeader class="p-0">
                                    <div class="flex items-center gap-3">
                                        <Avatar class="size-9 rounded-lg border border-border bg-transparent">
                                            {#if resource.icon}<AvatarImage src={resource.icon} alt="" class="object-contain" />{/if}
                                            <AvatarFallback class="rounded-none bg-muted/50">
                                                <Boxes class="size-4 text-muted-foreground" aria-hidden="true" />
                                            </AvatarFallback>
                                        </Avatar>
                                        <div class="min-w-0 flex-1">
                                            <CardTitle class="block truncate text-[15px] leading-tight">
                                                <a
                                                    href="/projects/{projectId}/{resource.id}"
                                                    class="before:absolute before:inset-0 before:rounded-xl hover:underline focus-visible:outline-none"
                                                >
                                                    {resource.name}
                                                </a>
                                            </CardTitle>
                                            <CardDescription class={cn("mt-0.5 block truncate", !resource.description?.trim() && "italic opacity-64")}>
                                                {resource.description?.trim() || ""}
                                            </CardDescription>
                                        </div>
                                        {#if resource.deploymentId && status}
                                            <Badge
                                                variant={statusVariant(status)}
                                                class="relative z-10 shrink-0"
                                                href="/projects/{resource.projectId}/{resource.id}/deployments/{resource.deploymentId}"
                                            >
                                                <span class={cn("size-1.5 rounded-full", dotClass(status))} aria-hidden="true"></span>
                                                {statusLabels[status]}
                                            </Badge>
                                        {:else}
                                            <Badge variant="outline" class="shrink-0">Not deployed</Badge>
                                        {/if}
                                    </div>
                                </CardHeader>
                                <div class="mt-4 flex min-w-0 items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                                    <span class="flex min-w-0 items-center gap-1">
                                        {#if active}
                                            <span class="spinner w-3 shrink-0 text-warning" aria-hidden="true"></span>
                                            <span class="truncate">{deployStep(status, resource.deploymentProgress)}…</span>
                                        {:else if resource.gitBranch}
                                            <GitBranch class="size-3.5 shrink-0" aria-hidden="true" />
                                            <span class="truncate">{resource.gitBranch}</span>
                                        {:else}
                                            <span class="truncate">{resource.type ?? "compose"}</span>
                                        {/if}
                                    </span>
                                    {#if active && resource.deploymentCreatedAt}
                                        <span class="shrink-0 tabular-nums">{elapsed(resource.deploymentCreatedAt, now)}</span>
                                    {:else if resource.deploymentCreatedAt}
                                        {@const at = active ? resource.deploymentCreatedAt : (resource.deploymentFinishedAt ?? resource.deploymentCreatedAt)}
                                        <time class="shrink-0" datetime={new Date(at).toISOString()}>
                                            {active ? "started" : status === "ready" ? "deployed" : status} {ago(at, now)}
                                        </time>
                                    {:else}
                                        <span class="shrink-0">updated {ago(resource.updatedAt, now)}</span>
                                    {/if}
                                </div>
                            </Card>
                        </li>
                    {/each}
                    {#if !isInternal}<li class="min-w-0">
                        <button
                            type="button"
                            class="flex h-full min-h-28 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-input hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64"
                            disabled={!ready}
                            onclick={() => openComposeDialog()}
                        >
                            <Plus class="size-4" aria-hidden="true" />
                            Add resource
                        </button>
                    </li>{/if}
                </ul>
            </main>
        {/if}
    {/if}
</div>

<style>
    .spinner::before {
        content: "⠋";
        animation: braille 0.8s steps(1) infinite;
    }

    @keyframes braille {
        10% { content: "⠙"; }
        20% { content: "⠹"; }
        30% { content: "⠸"; }
        40% { content: "⠼"; }
        50% { content: "⠴"; }
        60% { content: "⠦"; }
        70% { content: "⠧"; }
        80% { content: "⠇"; }
        90% { content: "⠏"; }
    }

    @media (prefers-reduced-motion: reduce) {
        .spinner::before { animation: none; }
    }
</style>

{#key projectId}
    <CreateResourceDialog
        bind:open={
            () => params.dialog.current === "create-resource",
            (open) => {
                if (!open && params.dialog.current === "create-resource") void params.set(null);
            }
        }
        {projectId}
    />
{/key}
