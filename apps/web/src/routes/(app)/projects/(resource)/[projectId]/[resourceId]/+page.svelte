<script lang="ts">
    import { beforeNavigate, goto } from "$app/navigation";
    import { page } from "$app/state";
    import ConnectionField from "$lib/components/clusters/connection-field.svelte";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import PreviewComposeDialog from "$lib/components/projects/preview-compose-dialog.svelte";
    import BucketOverview from "$lib/components/s3/bucket-overview.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import {
        ButtonGroup,
        ButtonGroupSeparator,
    } from "$lib/components/ui/group";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
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
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { containerInfo } from "$lib/resources/container-info";
    import ImageIcon from "$lib/components/shared/image-icon.svelte";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Box from "@lucide/svelte/icons/box";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Container from "@lucide/svelte/icons/container";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import { databaseEngine } from "@stoat/api/databases";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { onDestroy, untrack } from "svelte";
    import { Debounced } from "runed";

    useHeaderActions(deployAction);

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

    const clusterId = $derived(project?.clusterId ?? "");

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: projectId.length > 0 && resourceId.length > 0,
        }),
    );

    const resource = $derived(resourceQuery.data);

    const hasUndeployedChanges = $derived(
        (resource?.draftSpec ?? "") !== (resource?.spec ?? ""),
    );

    let deploymentId = $state<string | null>(null);

    // Navigate once the mutation settles; the unsaved-changes guard blocks while busy.
    $effect(() => {
        if (deploymentId && !deployMutation.isPending)
            void goto(
                `/projects/${projectId}/${resourceId}/deployments/${deploymentId}`,
            );
    });

    const containersQuery = createQuery(() =>
        orpc.resources.getContainers.queryOptions({
            input: { projectId, resourceId, clusterId },
            enabled:
                projectId.length > 0 &&
                resourceId.length > 0 &&
                clusterId.length > 0 &&
                Boolean(
                    resource?.spec?.trim() ||
                    resource?.draftSpec?.trim(),
                ),
        }),
    );

    const containers = $derived(containersQuery.data ?? []);

    const connectionQuery = createQuery(() =>
        orpc.resources.getConnection.queryOptions({
            input: { projectId, resourceId, clusterId },
            queryKey: [
                ...orpc.resources.getConnection.queryKey({
                    input: { projectId, resourceId, clusterId },
                }),
                resource?.updatedAt,
            ],
            enabled:
                !!resource &&
                databaseEngine(resource) === "postgresql" &&
                clusterId.length > 0,
        }),
    );

    let compose = $state("");

    const debouncedCompose = new Debounced(() => compose, 800);

    let loadedResourceId = $state("");

    let savedSpec = $state<string | null>(null);

    // Keep the source identity paired with the editor baseline, not live query data.
    let savedSource = $state<{
        connectionId: string;
        repositoryUrl: string;
        branch: string;
        path: string;
        revision: string;
    } | null>(null);

    let gitPending = $state(false);

    let gitError = $state("");

    let gitStatus = $state("");

    let generation = 0;

    let active = true;

    const isDirty = $derived(compose !== (savedSpec ?? ""));

    beforeNavigate((navigation) => {
        if (busy || isDirty) {
            if (
                navigation.willUnload ||
                busy ||
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
        // Route components are reused when switching between resources.
        const identity = `${projectId}/${resourceId}`;
        untrack(() => {
            if (identity) generation++;
            debouncedCompose.cancel();
            loadedResourceId = "";
            compose = "";
            savedSpec = null;
            savedSource = null;
            gitError = gitStatus = "";
            gitPending = false;
            saveMutation.reset();
            externalConnectionMutation.reset();
            deployMutation.reset();
            deploymentId = null;
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
            } else if (!isDirty && !busy) {
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

    const externalConnectionMutation = createMutation(() =>
        orpc.resources.enableExternalConnection.mutationOptions({
            onSuccess: (updated, input) => {
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
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
                if (
                    !active ||
                    projectId !== input.projectId ||
                    resourceId !== input.resourceId
                )
                    return;
                compose = updated.draftSpec ?? "";
                savedSpec = updated.draftSpec;
                debouncedCompose.setImmediately(compose);
                saveMutation.reset();
            },
        }),
    );

    function enableExternalConnection() {
        if (
            readOnly ||
            busy ||
            isDirty ||
            loadedResourceId !== resourceId ||
            !savedSpec
        )
            return;
        externalConnectionMutation.mutate({
            projectId,
            resourceId,
            clusterId,
            expectedSpec: savedSpec,
            expectedSource: savedSource ? { ...savedSource } : null,
        });
    }

    const deployMutation = createMutation(() =>
        orpc.resources.deploy.mutationOptions({
            onSuccess: (deployment, input) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.key(),
                });

                if (
                    !active ||
                    projectId !== input.projectId ||
                    resourceId !== input.resourceId
                )
                    return;
                deploymentId = deployment.id;
            },
        }),
    );

    const busy = $derived(
        gitPending ||
            saveMutation.isPending ||
            externalConnectionMutation.isPending ||
            deployMutation.isPending,
    );

    const formattedComposeQuery = createQuery(() =>
        orpc.resources.getFormattedCompose.queryOptions({
            input: { projectId, resourceId },
            // Validate each saved version, never the unsaved editor text.
            queryKey: [
                ...orpc.resources.getFormattedCompose.queryKey({
                    input: { projectId, resourceId },
                }),
                resource?.updatedAt,
            ],
            enabled:
                !!resource?.draftSpec?.trim() && !isDirty && !busy,
            retry: false,
        }),
    );

    const canDeploy = $derived(
        !!resource &&
            !!project &&
            loadedResourceId === resourceId &&
            !!savedSpec?.trim() &&
            savedSpec === resource.draftSpec &&
            !isDirty &&
            !busy &&
            !resourceQuery.isFetching &&
            formattedComposeQuery.isSuccess &&
            !formattedComposeQuery.isFetching &&
            formattedComposeQuery.data.serviceCount > 0,
    );

    function deploySavedDraft(recreate = false) {
        if (!canDeploy) return;
        deployMutation.mutate({ projectId, resourceId, recreate });
    }

    // Autosave the draft after the user stops typing instead of a save button.
    $effect(() => {
        const target = debouncedCompose.current;
        const debouncePending = debouncedCompose.pending;
        const currentText = compose;
        const baseline = savedSpec;
        const baselineSource = savedSource;
        const loaded = loadedResourceId;
        const pid = projectId;
        const rid = resourceId;
        const locked =
            readOnly ||
            gitPending ||
            deployMutation.isPending ||
            externalConnectionMutation.isPending ||
            saveMutation.isPending;
        const settled = !debouncePending && currentText === target;
        const dirty = target !== (baseline ?? "");
        const ready =
            !locked && pid !== "" && rid !== "" && loaded === rid;

        if (!settled || !dirty || !ready) return;

        untrack(() => {
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
        if (busy || !resource || loadedResourceId !== resourceId)
            return false;

        if (
            (action === "source" || action === "pull") &&
            (isDirty || savedSpec !== null) &&
            !window.confirm(
                "Replace the current Compose draft with the Git version? Saved local drafts and unsaved edits will be replaced.",
            )
        )
            return false;

        if (
            action === "detach" &&
            !window.confirm(
                "Detach the Git source? The current Compose spec and editor text will be retained.",
            )
        )
            return false;
        const input = { projectId, resourceId };
        const currentGeneration = generation;
        const submitted = compose;
        const expectedSpec = savedSpec;
        const expectedSource = savedSource
            ? { ...savedSource }
            : null;
        const expectedRevision = expectedSource?.revision;
        gitPending = true;
        gitError = gitStatus = "";

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
                    spec: submitted,
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

            if (
                !active ||
                generation !== currentGeneration ||
                projectId !== input.projectId ||
                resourceId !== input.resourceId
            )
                return false;

            // Do not overwrite text typed while a request was in flight, or a draft on detach.
            if (action !== "detach" && compose === submitted)
                compose = updated.draftSpec ?? "";
            savedSpec = updated.draftSpec;
            debouncedCompose.setImmediately(compose);
            savedSource =
                updated.gitConnectionId && updated.gitSource
                    ? {
                          connectionId: updated.gitConnectionId,
                          ...updated.gitSource,
                      }
                    : null;
            saveMutation.reset();
            gitStatus = Match.value(action).pipe(
                Match.when(
                    "push",
                    () => "Commit pushed and draft saved.",
                ),
                Match.when(
                    "detach",
                    () => "Git source detached. Compose retained.",
                ),
                Match.orElse(() => "Compose imported from Git."),
            );

            return true;
        } catch (cause) {
            if (active && generation === currentGeneration)
                gitError = `${cause instanceof Error ? cause.message : "Git operation failed."} Your editor text has been kept.`;

            return false;
        } finally {
            if (active && generation === currentGeneration)
                gitPending = false;
        }
    }
</script>

<svelte:head>
    <title>{resource?.name ?? "Resource"} / Stoat</title>
</svelte:head>

{#snippet deployAction()}
    {#if !readOnly && resource?.type !== "bucket"}
        <ButtonGroup>
            <Button
                onclick={() => deploySavedDraft()}
                loading={deployMutation.isPending}
                disabled={!canDeploy}
                title={hasUndeployedChanges
                    ? "Saved draft has undeployed changes"
                    : "Deploy"}
            >
                <span class="inline-flex items-baseline gap-0.5">
                    Deploy
                    {#if hasUndeployedChanges}
                        <span
                            class="inline-block origin-center text-md leading-none text-orange-500 scale-125"
                            aria-hidden="true"
                        >
                            *
                        </span>
                        <span class="sr-only">
                            (undeployed changes)
                        </span>
                    {/if}
                </span>
            </Button>
            <ButtonGroupSeparator />
            <Menu>
                <MenuTrigger
                    class={buttonVariants({ size: "icon" })}
                    disabled={!canDeploy}
                    aria-label="More deploy options"
                >
                    <ChevronDown aria-hidden="true" />
                </MenuTrigger>
                <MenuPopup align="end">
                    <MenuItem onclick={() => deploySavedDraft(true)}>
                        <RefreshCw aria-hidden="true" />
                        Recreate
                    </MenuItem>
                </MenuPopup>
            </Menu>
        </ButtonGroup>
    {/if}
{/snippet}

{#if resource?.type === "bucket"}
    <BucketOverview {projectId} {resourceId} name={resource.name} />
{:else}
    <div class="flex w-full flex-col gap-6 pt-6 xl:min-h-0 xl:flex-1">
        {#if projectQuery.isPending || resourceQuery.isPending}
            <Skeleton loading loading-label="Loading resource">
                <div class="space-y-6">
                    <div
                        class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0"
                    >
                        <Frame
                            class="w-full min-w-0 xl:col-span-1 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
                        >
                            <FrameHeader class="shrink-0">
                                <FrameTitle class="text-base">
                                    <h2>Containers</h2>
                                </FrameTitle>
                                <FrameDescription class="mt-1">
                                    Runtime status across machines.
                                </FrameDescription>
                            </FrameHeader>
                            <FramePanel
                                class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none"
                            >
                                <div
                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                                >
                                    <span
                                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                    >
                                        <Box
                                            class="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <div class="min-w-0">
                                        <h3
                                            class="truncate text-sm font-medium leading-5"
                                        >
                                            Container service
                                        </h3>
                                        <p
                                            class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                        >
                                            image:latest &middot;
                                            machine
                                        </p>
                                    </div>
                                    <Badge
                                        variant="secondary"
                                        class="col-start-2 sm:col-start-auto"
                                    >
                                        Healthy
                                    </Badge>
                                </div>
                            </FramePanel>
                        </Frame>
                        <Frame
                            class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
                        >
                            <FrameHeader
                                class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
                            >
                                <div class="min-w-0">
                                    <FrameTitle class="text-base">
                                        <h2>Docker Compose</h2>
                                    </FrameTitle>
                                    <FrameDescription class="mt-1">
                                        Edit the Docker Compose YAML
                                        for this resource.
                                    </FrameDescription>
                                </div>
                                <div
                                    class="flex flex-wrap items-center gap-2"
                                >
                                    <Button
                                        variant="secondary"
                                        disabled
                                    >
                                        Preview compose
                                    </Button>
                                </div>
                            </FrameHeader>
                            <FramePanel
                                class="min-h-88 overflow-hidden bg-code p-0 dark:bg-black/20"
                            />
                        </Frame>
                    </div>
                </div>
            </Skeleton>
        {:else if projectQuery.isError}
            <div class="space-y-4">
                <Alert variant="error">
                    <AlertDescription>
                        Unable to load project: {projectQuery.error
                            .message}
                    </AlertDescription>
                </Alert>
                <Button variant="outline" size="sm" href="/projects">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to projects
                </Button>
            </div>
        {:else if !project}
            <Empty
                class="rounded-xl border border-dashed border-border"
            >
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
                        <ArrowLeft
                            class="size-4"
                            aria-hidden="true"
                        />
                        Back to projects
                    </Button>
                </EmptyContent>
            </Empty>
        {:else if resourceQuery.isError}
            <div class="space-y-4">
                <Alert variant="error">
                    <AlertDescription>
                        Unable to load resource: {resourceQuery.error
                            .message}
                    </AlertDescription>
                </Alert>
                <Button
                    variant="outline"
                    size="sm"
                    href="/projects/{projectId}"
                >
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to {project.name}
                </Button>
            </div>
        {:else if !resource}
            <Empty
                class="rounded-xl border border-dashed border-border"
            >
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Container aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>Resource not found</EmptyTitle>
                    <EmptyDescription>
                        It may have been deleted or belong to another
                        organization.
                    </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button size="sm" href="/projects/{projectId}">
                        <ArrowLeft
                            class="size-4"
                            aria-hidden="true"
                        />
                        Back to {project.name}
                    </Button>
                </EmptyContent>
            </Empty>
        {:else}
            <div
                class="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0"
            >
                <div
                    class="flex min-w-0 flex-col gap-6 xl:col-span-1 xl:row-span-2 xl:min-h-0"
                >
                    {#if connectionQuery.data}
                        <Frame
                            class="min-w-0"
                            role="region"
                            aria-labelledby="connection-heading"
                        >
                            <FrameHeader>
                                <FrameTitle class="text-base">
                                    <h2 id="connection-heading">
                                        Connection
                                    </h2>
                                </FrameTitle>
                                <FrameDescription class="mt-1">
                                    Built from the saved Compose draft
                                    and POSTGRES_* variables.
                                </FrameDescription>
                            </FrameHeader>
                            <FramePanel class="grid gap-4">
                                <ConnectionField
                                    label="Internal URL"
                                    value={connectionQuery.data
                                        .internal}
                                    secret
                                />
                                {#if connectionQuery.data.external}
                                    <ConnectionField
                                        label="External URL"
                                        value={connectionQuery.data
                                            .external}
                                        secret
                                    />
                                {:else if connectionQuery.data.externalPort}
                                    <p
                                        class="text-sm text-muted-foreground"
                                    >
                                        External port {connectionQuery
                                            .data.externalPort} is configured,
                                        but no machine address is available.
                                    </p>
                                {/if}
                                {#if connectionQuery.data.pendingDeployment}
                                    <p
                                        role="status"
                                        class="text-sm text-warning-foreground"
                                    >
                                        External connection not
                                        deployed yet. Deploy to apply
                                        the external port.
                                    </p>
                                {/if}
                                {#if !connectionQuery.data.externalPort && !readOnly}
                                    <div class="grid gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onclick={enableExternalConnection}
                                            loading={externalConnectionMutation.isPending}
                                            disabled={busy ||
                                                isDirty ||
                                                loadedResourceId !==
                                                    resourceId ||
                                                !savedSpec}
                                        >
                                            Enable external connection
                                        </Button>
                                        <p
                                            class="text-xs text-muted-foreground"
                                        >
                                            Adds an unused host port
                                            to the Compose draft.
                                            After deployment,
                                            PostgreSQL will be
                                            reachable outside the
                                            cluster wherever your
                                            firewall allows.
                                        </p>
                                    </div>
                                {/if}
                                {#if externalConnectionMutation.isError}
                                    <Alert variant="error">
                                        <AlertDescription>
                                            {externalConnectionMutation
                                                .error.message}
                                        </AlertDescription>
                                    </Alert>
                                {/if}
                            </FramePanel>
                        </Frame>
                    {/if}
                    <Frame
                        class="w-full min-w-0 xl:min-h-0 xl:flex-1"
                        role="region"
                        aria-labelledby="containers-heading"
                    >
                        <FrameHeader class="shrink-0">
                            <div
                                class="flex flex-wrap items-center justify-between gap-2"
                            >
                                <FrameTitle class="text-base">
                                    <h2 id="containers-heading">
                                        Containers
                                    </h2>
                                </FrameTitle>
                                <span
                                    class="text-xs tabular-nums text-muted-foreground"
                                >
                                    {#if (resource.spec?.trim() || resource.draftSpec?.trim()) && containersQuery.data !== undefined}
                                        {containers.length}
                                        {containers.length === 1
                                            ? "container"
                                            : "containers"}
                                    {/if}
                                </span>
                            </div>
                            <FrameDescription class="mt-1">
                                Runtime status across machines.
                            </FrameDescription>
                        </FrameHeader>
                        <FramePanel
                            class="max-h-96 overflow-y-auto p-0 xl:min-h-0 xl:max-h-none xl:flex-1"
                        >
                            {#if !(resource.spec?.trim() || resource.draftSpec?.trim())}
                                <Empty
                                    class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                                >
                                    <EmptyHeader>
                                        <EmptyDescription>
                                            Save a Compose spec to
                                            view this resource's
                                            containers.
                                        </EmptyDescription>
                                    </EmptyHeader>
                                </Empty>
                            {:else}
                                {#if containersQuery.isError}
                                    <Alert
                                        variant="error"
                                        class="m-3"
                                    >
                                        <AlertDescription>
                                            Unable to load containers: {containersQuery
                                                .error.message}
                                            {#if containers.length > 0}Showing
                                                previously loaded
                                                containers.{/if}
                                        </AlertDescription>
                                    </Alert>
                                {/if}
                                {#if containersQuery.isPending}
                                    <Skeleton
                                        loading
                                        count={2}
                                        count-gap={1}
                                        loading-label="Loading containers"
                                    >
                                        <div
                                            class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                                        >
                                            <span
                                                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                            >
                                                <Box
                                                    class="size-5"
                                                    aria-hidden="true"
                                                />
                                            </span>
                                            <div class="min-w-0">
                                                <h3
                                                    class="truncate text-sm font-medium leading-5"
                                                >
                                                    Container service
                                                </h3>
                                                <p
                                                    class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                                >
                                                    image:latest
                                                    &middot; machine
                                                </p>
                                            </div>
                                            <Badge
                                                variant="secondary"
                                                class="col-start-2 sm:col-start-auto"
                                            >
                                                Healthy
                                            </Badge>
                                        </div>
                                    </Skeleton>
                                {:else if containers.length > 0}
                                    <ul>
                                        {#each containers as item, index (`${item.machineId}-${item.container.Id ?? index}`)}
                                            {@const info =
                                                containerInfo(
                                                    item.container,
                                                )}
                                            <li class="min-w-0">
                                                {#if index > 0}<Separator
                                                    />{/if}
                                                <div
                                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                                                >
                                                    <ImageIcon
                                                        image={info.image}
                                                    />
                                                    <div
                                                        class="min-w-0"
                                                    >
                                                        <h3
                                                            class="truncate text-sm font-medium leading-5"
                                                            title={info.name}
                                                        >
                                                            {info.name}
                                                        </h3>
                                                        <p
                                                            class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                                            title={`${info.image} · ${item.machineName || item.machineId || "Unknown machine"}${info.id ? ` · ${info.id}` : ""}`}
                                                        >
                                                            {info.image}
                                                            &middot;
                                                            {item.machineName ||
                                                                item.machineId ||
                                                                "Unknown machine"}
                                                            {#if info.id}
                                                                &middot;
                                                                <span
                                                                    class="font-mono"
                                                                    title={info.id}
                                                                >
                                                                    {info.id.slice(
                                                                        0,
                                                                        12,
                                                                    )}
                                                                </span>
                                                            {/if}
                                                        </p>
                                                    </div>
                                                    <Badge
                                                        variant={info.healthVariant}
                                                        class="col-start-2 shrink-0 justify-self-start whitespace-nowrap capitalize sm:col-start-auto sm:justify-self-end"
                                                        aria-label={`Health: ${info.health}. Runtime status: ${info.status}`}
                                                        title={`Runtime status: ${info.status}`}
                                                    >
                                                        {info.health}
                                                    </Badge>
                                                </div>
                                            </li>
                                        {/each}
                                    </ul>
                                {:else if !containersQuery.isError}
                                    <Empty
                                        class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
                                    >
                                        <EmptyHeader>
                                            <EmptyDescription>
                                                No containers found.
                                            </EmptyDescription>
                                        </EmptyHeader>
                                    </Empty>
                                {/if}
                            {/if}
                        </FramePanel>
                    </Frame>
                </div>
                <Frame
                    id="compose-editor"
                    class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
                    role="region"
                    aria-labelledby="compose-heading"
                >
                    <FrameHeader
                        class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
                    >
                        <div class="min-w-0">
                            <FrameTitle class="text-base">
                                <h2 id="compose-heading">
                                    Docker Compose
                                </h2>
                            </FrameTitle>
                            <FrameDescription class="mt-1">
                                Edit the Docker Compose YAML for this
                                resource.
                            </FrameDescription>
                        </div>
                        <div
                            class="flex flex-wrap items-center gap-2"
                        >
                            <div class="text-sm" aria-live="polite">
                                {#if saveMutation.isError}
                                    <Alert
                                        variant="error"
                                        class="w-auto px-2 py-1.5"
                                    >
                                        <AlertDescription>
                                            Unable to save: {saveMutation
                                                .error.message}
                                        </AlertDescription>
                                    </Alert>
                                {:else if saveMutation.isPending}
                                    <p class="text-muted-foreground">
                                        Saving...
                                    </p>
                                {:else if isDirty}
                                    <p class="text-muted-foreground">
                                        Unsaved changes
                                    </p>
                                {:else if hasUndeployedChanges}
                                    <p class="text-muted-foreground">
                                        Draft saved.
                                    </p>
                                {/if}
                            </div>
                            <PreviewComposeDialog
                                {projectId}
                                {resourceId}
                            />
                            {#if readOnly}
                                <Badge variant="secondary">
                                    System-managed
                                </Badge>
                            {/if}
                            {#if deployMutation.isError}
                                <Alert variant="error" class="w-full">
                                    <AlertDescription>
                                        Unable to deploy: {deployMutation
                                            .error.message}
                                    </AlertDescription>
                                </Alert>
                            {:else if !isDirty && savedSpec?.trim() && formattedComposeQuery.isError}
                                <Alert variant="error" class="w-full">
                                    <AlertDescription>
                                        Saved draft cannot be
                                        deployed: {formattedComposeQuery
                                            .error.message}
                                    </AlertDescription>
                                </Alert>
                            {/if}
                        </div>
                    </FrameHeader>
                    <FramePanel
                        class="min-h-0 overflow-hidden bg-code p-0 transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20 dark:bg-black/20"
                    >
                        <div class="compose-editor-canvas">
                            {#key resource.id}
                                <CodeEditor
                                    bind:value={compose}
                                    readOnly={readOnly ||
                                        externalConnectionMutation.isPending ||
                                        gitPending ||
                                        deployMutation.isPending ||
                                        loadedResourceId !==
                                            resource.id}
                                />
                            {/key}
                        </div>
                    </FramePanel>
                </Frame>
            </div>
        {/if}
    </div>
{/if}

<style>
    @media (min-width: 80rem) {
        .compose-editor-canvas,
        .compose-editor-canvas > :global(div),
        .compose-editor-canvas :global(.cm-editor) {
            height: 100%;
            min-height: 0;
        }

        .compose-editor-canvas :global(.cm-scroller) {
            min-height: 0;
            max-height: none;
        }
    }
</style>
