<script lang="ts">
    import { beforeNavigate, goto } from "$app/navigation";
    import { page } from "$app/state";
    import PostgresConnectionCard from "$lib/components/projects/postgres-connection-card.svelte";
    import ResourceComposeEditor from "$lib/components/projects/resource-compose-editor.svelte";
    import ResourceContainersCard from "$lib/components/projects/resource-containers-card.svelte";
    import ResourcePageSkeleton from "$lib/components/projects/resource-page-skeleton.svelte";
    import BucketOverview from "$lib/components/s3/bucket-overview.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
    import { orpc, queryClient } from "$lib/api/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Container from "@lucide/svelte/icons/container";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import { databaseEngine } from "@stoat/api/databases";
    import {
        createMutation,
        createQuery,
        partialMatchKey,
    } from "@tanstack/svelte-query";
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

    const isPostgres = $derived(
        !!resource && databaseEngine(resource) === "postgresql",
    );

    const connectionQuery = createQuery(() => {
        const resourceKey = orpc.resources.getConnection.queryKey({
            input: { projectId, resourceId, clusterId },
        });

        return orpc.resources.getConnection.queryOptions({
            input: { projectId, resourceId, clusterId },
            queryKey: [...resourceKey, resource?.updatedAt],
            enabled: isPostgres && clusterId.length > 0,
            // Keep the card on screen while a save refetches, but never show another resource's URLs.
            placeholderData: (previous, previousQuery) =>
                previousQuery &&
                partialMatchKey(previousQuery.queryKey, resourceKey)
                    ? previous
                    : undefined,
        });
    });

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

    let active = true;

    const isDirty = $derived(compose !== (savedSpec ?? ""));

    // Leaving with unsaved edits saves them first, then continues, so nothing typed is lost.
    // Closing or reloading the tab cannot wait for a save, so the browser asks instead.
    let resumedTo = "";

    beforeNavigate((navigation) => {
        // The navigation this guard resumes after saving; query state may still read busy.
        if (navigation.to?.url.href === resumedTo) return;

        if (!busy && !isDirty) return;
        navigation.cancel();

        if (navigation.willUnload || busy || !navigation.to) return;
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
        // Route components are reused when switching between resources.
        void projectId;
        void resourceId;
        untrack(() => {
            debouncedCompose.cancel();
            loadedResourceId = "";
            compose = "";
            savedSpec = null;
            savedSource = null;
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

    const saveStatus = $derived(
        saveMutation.isPending
            ? "saving"
            : isDirty
              ? "unsaved"
              : hasUndeployedChanges
                ? "saved"
                : "",
    );

    function deploySavedDraft(recreate = false) {
        if (!canDeploy) return;
        deployMutation.mutate({ projectId, resourceId, recreate });
    }

    /** Saves the editor text without waiting for the autosave delay; false if it failed. */
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
            // The editor shows the save error.
            return false;
        }
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
</script>

<svelte:head>
    <title>{resource?.name ?? "Resource"} / Stoat</title>
</svelte:head>

{#snippet deployAction()}
    {#if !readOnly && resource?.type !== "bucket" && page.data.isOrganizationAdmin}
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
            <ResourcePageSkeleton />
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
                    {#if connectionQuery.data || (isPostgres && connectionQuery.isPending)}
                        <PostgresConnectionCard
                            connection={connectionQuery.data ??
                                undefined}
                            {readOnly}
                            enabling={externalConnectionMutation.isPending}
                            canEnable={!busy &&
                                !isDirty &&
                                loadedResourceId === resourceId &&
                                !!savedSpec}
                            errorMessage={externalConnectionMutation
                                .error?.message}
                            onEnable={enableExternalConnection}
                        />
                    {/if}
                    <ResourceContainersCard
                        {containers}
                        hasSpec={!!(
                            resource.spec?.trim() ||
                            resource.draftSpec?.trim()
                        )}
                        loaded={containersQuery.data !== undefined}
                        pending={containersQuery.isPending}
                        errorMessage={containersQuery.error?.message}
                    />
                </div>
                <ResourceComposeEditor
                    {projectId}
                    {resourceId}
                    editorKey={resource.id}
                    bind:compose
                    {readOnly}
                    editorLocked={externalConnectionMutation.isPending ||
                        deployMutation.isPending ||
                        loadedResourceId !== resource.id}
                    {saveStatus}
                    saveError={saveMutation.error?.message}
                    deployError={deployMutation.error?.message}
                    composeError={!isDirty && savedSpec?.trim()
                        ? formattedComposeQuery.error?.message
                        : undefined}
                />
            </div>
        {/if}
    </div>
{/if}
