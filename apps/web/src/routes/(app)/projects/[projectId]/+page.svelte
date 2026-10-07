<script lang="ts">
    import { page } from "$app/state";
    import BucketIcon from "$lib/components/shared/bucket-icon.svelte";
    import {
        dotClass,
        statusLabels,
        type ResourceStatus,
    } from "$lib/components/home/project-overview-card.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Avatar,
        AvatarFallback,
        AvatarImage,
    } from "$lib/components/ui/avatar";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardTitle,
    } from "$lib/components/ui/card";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        deploymentStatusVariant,
        isActiveDeploymentStatus,
    } from "$lib/deployments/status";
    import { subscribeToStream } from "$lib/deployments/stream";
    import { ago, elapsed } from "$lib/format";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { s3BucketStatusVariant } from "$lib/s3";
    import { cn } from "$lib/utils";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Container from "@lucide/svelte/icons/container";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import Plus from "@lucide/svelte/icons/plus";
    import { createQuery } from "@tanstack/svelte-query";
    import { onMount } from "svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    const isInternal = $derived(project?.isInternal === true);

    const resourcesQuery = createQuery(() =>
        orpc.resources.listResources.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const resources = $derived(resourcesQuery.data ?? []);

    const createHref = $derived(`/projects/${projectId}/create`);

    let now = $state(Date.now());

    let watchError = $state("");

    const summary = $derived.by(() => {
        const count = (match: (status: ResourceStatus) => boolean) =>
            resources.filter(
                (resource) =>
                    resource.type !== "bucket" &&
                    match(resource.deploymentStatus),
            ).length;

        return [
            {
                label: "deployed",
                dot: dotClass("ready"),
                count: count((s) => s === "ready"),
            },
            {
                label: "deploying",
                dot: dotClass("running"),
                count: count(
                    (s) => s === "queued" || s === "running",
                ),
            },
            {
                label: "failed",
                dot: dotClass("failed"),
                count: count((s) => s === "failed"),
            },
            {
                label: "not deployed",
                dot: dotClass(null),
                count: count((s) => s === null || s === "cancelled"),
            },
        ].filter((item) => item.count > 0);
    });

    useHeaderActions(newResourceAction);

    onMount(() => {
        const clock = setInterval(() => (now = Date.now()), 1_000);

        // Deployment row changes (not log lines) refresh every resource status on the page.
        const stop = subscribeToStream(
            (signal) =>
                client.cluster.watchDeployments(undefined, {
                    signal,
                }),
            () => {
                watchError = "";
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                });
            },
            (error, reconnecting) => {
                watchError = `${error.message || "Live updates unavailable."}${reconnecting ? " Reconnecting..." : " Reload the page to reconnect."}`;
            },
        );

        return () => {
            clearInterval(clock);
            stop();
        };
    });

    // Mirrors the progress checkpoints set by the DeployResource worker.
    function deployStep(
        status: ResourceStatus,
        progress: number | null,
    ) {
        if (status === "queued") return "queued";

        if ((progress ?? 0) < 5) return "preparing";

        if ((progress ?? 0) < 10) return "planning";

        return "starting services";
    }
</script>

<svelte:head>
    <title>{project?.name ?? "Project"} / Stoat</title>
</svelte:head>

{#snippet newResourceAction()}
    {#if project && !isInternal}
        <Button size="sm" href={createHref}>
            <Plus class="size-4" aria-hidden="true" />
            New resource
        </Button>
    {/if}
{/snippet}

<div
    class="flex min-h-[calc(100dvh-7rem)] w-full flex-col space-y-6 pt-6"
>
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
                    It may have been deleted or belong to another
                    organization.
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
            <Alert variant="warning">
                <AlertDescription>{watchError}</AlertDescription>
            </Alert>
        {/if}

        {#if isInternal}
            <Alert variant="info">
                <AlertDescription>
                    Stoat manages these internal services for this
                    cluster. They're read-only here and only admins
                    can see them.
                </AlertDescription>
            </Alert>
        {/if}

        {#if projectQuery.isPending || resourcesQuery.isPending}
            <Skeleton loading loading-label="Loading resources">
                <div class="space-y-4">
                    <ul
                        class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                    >
                        {#each { length: 4 }, index (index)}
                            <li class="min-w-0">
                                <Card class="h-full gap-0 p-4">
                                    <CardHeader class="p-0">
                                        <div
                                            class="flex items-center gap-3"
                                        >
                                            <span
                                                class="size-9 shrink-0 rounded-lg border border-border"
                                            ></span>
                                            <div
                                                class="min-w-0 flex-1"
                                            >
                                                <CardTitle
                                                    class="block truncate text-[15px] leading-tight"
                                                >
                                                    Resource name
                                                </CardTitle>
                                                <CardDescription
                                                    class="mt-0.5 block truncate"
                                                >
                                                    Resource
                                                    description
                                                </CardDescription>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                class="shrink-0"
                                            >
                                                Deployed
                                            </Badge>
                                        </div>
                                    </CardHeader>
                                    <div
                                        class="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs"
                                    >
                                        <span>main</span>
                                        <span>deployed 1h ago</span>
                                    </div>
                                </Card>
                            </li>
                        {/each}
                    </ul>
                </div>
            </Skeleton>
        {:else if resourcesQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    Unable to load resources: {resourcesQuery.error
                        .message}
                </AlertDescription>
            </Alert>
        {:else if resources.length === 0}
            <Empty
                class="rounded-xl border border-dashed border-border"
            >
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
                    <Button size="sm" href={createHref}>
                        <Plus class="size-4" aria-hidden="true" />
                        New resource
                    </Button>
                </EmptyContent>
            </Empty>
        {:else}
            <main class="space-y-4">
                <ul
                    class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                >
                    {#each resources as resource (resource.id)}
                        {@const status = resource.deploymentStatus}
                        {@const active =
                            status !== null &&
                            isActiveDeploymentStatus(status)}
                        <li class="min-w-0">
                            <Card
                                class="relative h-full gap-0 overflow-hidden p-4 transition-colors hover:bg-accent/50 focus-within:bg-accent/50"
                            >
                                <CardHeader class="p-0">
                                    <div
                                        class="flex items-center gap-3"
                                    >
                                        <Avatar
                                            class="size-9 rounded-lg border border-border bg-transparent"
                                        >
                                            {#if resource.icon}<AvatarImage
                                                    src={resource.icon}
                                                    alt=""
                                                    class="object-contain"
                                                />{/if}
                                            <AvatarFallback
                                                class="rounded-none bg-muted/50"
                                            >
                                                {#if resource.type === "bucket"}
                                                    <BucketIcon
                                                        class="size-5 text-muted-foreground"
                                                        aria-hidden="true"
                                                    />
                                                {:else}
                                                    <Boxes
                                                        class="size-5 text-muted-foreground"
                                                        aria-hidden="true"
                                                    />
                                                {/if}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div class="min-w-0 flex-1">
                                            <CardTitle
                                                class="block truncate text-[15px] leading-tight"
                                            >
                                                <a
                                                    href="/projects/{projectId}/{resource.id}"
                                                    class="before:absolute before:inset-0 before:rounded-xl hover:underline focus-visible:outline-none"
                                                >
                                                    {resource.name}
                                                </a>
                                            </CardTitle>
                                            <CardDescription
                                                class={cn(
                                                    "mt-0.5 block truncate",
                                                    !resource.description?.trim() &&
                                                        "italic opacity-64",
                                                )}
                                            >
                                                {resource.description?.trim() ||
                                                    ""}
                                            </CardDescription>
                                        </div>
                                        {#if resource.bucketStatus}
                                            <Badge
                                                variant={s3BucketStatusVariant[
                                                    resource
                                                        .bucketStatus
                                                ]}
                                                class="shrink-0 capitalize"
                                            >
                                                {resource.bucketStatus}
                                            </Badge>
                                        {:else if resource.deploymentId && status}
                                            <Badge
                                                variant={deploymentStatusVariant(
                                                    status,
                                                )}
                                                class="relative z-10 shrink-0"
                                                href="/projects/{resource.projectId}/{resource.id}/deployments/{resource.deploymentId}"
                                            >
                                                <span
                                                    class={cn(
                                                        "size-1.5 rounded-full",
                                                        dotClass(
                                                            status,
                                                        ),
                                                    )}
                                                    aria-hidden="true"
                                                ></span>
                                                {statusLabels[status]}
                                            </Badge>
                                        {:else}
                                            <Badge
                                                variant="outline"
                                                class="shrink-0"
                                            >
                                                Not deployed
                                            </Badge>
                                        {/if}
                                    </div>
                                </CardHeader>
                                <div
                                    class="mt-4 flex min-w-0 items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground"
                                >
                                    <span
                                        class="flex min-w-0 items-center gap-1"
                                    >
                                        {#if active}
                                            <span
                                                class="spinner w-3 shrink-0 text-warning"
                                                aria-hidden="true"
                                            ></span>
                                            <span class="truncate">
                                                {deployStep(
                                                    status,
                                                    resource.deploymentProgress,
                                                )}…
                                            </span>
                                        {:else if resource.gitBranch}
                                            <GitBranch
                                                class="size-3.5 shrink-0"
                                                aria-hidden="true"
                                            />
                                            <span class="truncate">
                                                {resource.gitBranch}
                                            </span>
                                        {:else}
                                            <span class="truncate">
                                                {resource.engine ??
                                                    resource.type ??
                                                    "compose"}
                                            </span>
                                        {/if}
                                    </span>
                                    {#if active && resource.deploymentCreatedAt}
                                        <span
                                            class="shrink-0 tabular-nums"
                                        >
                                            {elapsed(
                                                resource.deploymentCreatedAt,
                                                now,
                                            )}
                                        </span>
                                    {:else if resource.deploymentCreatedAt}
                                        {@const at = active
                                            ? resource.deploymentCreatedAt
                                            : (resource.deploymentFinishedAt ??
                                              resource.deploymentCreatedAt)}
                                        <time
                                            class="shrink-0"
                                            datetime={new Date(
                                                at,
                                            ).toISOString()}
                                        >
                                            {active
                                                ? "started"
                                                : status === "ready"
                                                  ? "deployed"
                                                  : status}
                                            {ago(at, now)}
                                        </time>
                                    {:else}
                                        <span class="shrink-0">
                                            updated {ago(
                                                resource.updatedAt,
                                                now,
                                            )}
                                        </span>
                                    {/if}
                                </div>
                            </Card>
                        </li>
                    {/each}
                    {#if !isInternal}<li class="min-w-0">
                            <a
                                href={createHref}
                                class="flex h-full min-h-28 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-input hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <Plus
                                    class="size-4"
                                    aria-hidden="true"
                                />
                                Add resource
                            </a>
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
        10% {
            content: "⠙";
        }
        20% {
            content: "⠹";
        }
        30% {
            content: "⠸";
        }
        40% {
            content: "⠼";
        }
        50% {
            content: "⠴";
        }
        60% {
            content: "⠦";
        }
        70% {
            content: "⠧";
        }
        80% {
            content: "⠇";
        }
        90% {
            content: "⠏";
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .spinner::before {
            animation: none;
        }
    }
</style>
