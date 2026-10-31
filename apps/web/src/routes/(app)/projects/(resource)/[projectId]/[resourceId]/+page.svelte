<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import PostgresConnectionCard from "$lib/components/projects/postgres-connection-card.svelte";
    import DeployConflictDialog from "$lib/components/projects/deploy-conflict-dialog.svelte";
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
    import {
        Tooltip,
        TooltipPopup,
        TooltipTrigger,
    } from "$lib/components/ui/tooltip";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { ORPCError } from "@orpc/client";
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
    import { ComposeDraft } from "$lib/resources/compose-draft.svelte";

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

    const draft = new ComposeDraft({
        projectId: () => projectId,
        resourceId: () => resourceId,
        resource: () => resource,
        readOnly: () => readOnly,
        busy: () =>
            externalConnectionMutation.isPending ||
            deployMutation.isPending ||
            reloadMutation.isPending,
        paused: () => false,
        onSwitch: () => {
            externalConnectionMutation.reset();
            deployMutation.reset();
            reloadMutation.reset();
            conflictOpen = false;
            deploymentId = null;
        },
    });

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
                    projectId !== input.projectId ||
                    resourceId !== input.resourceId
                )
                    return;
                draft.accept(updated);
                draft.save.reset();
            },
        }),
    );

    const canEnableExternalConnection = $derived(
        !readOnly &&
            !draft.busy &&
            !draft.isDirty &&
            draft.loaded &&
            !!draft.savedSpec,
    );

    function enableExternalConnection() {
        if (!canEnableExternalConnection || !draft.savedSpec) return;
        externalConnectionMutation.mutate({
            projectId,
            resourceId,
            clusterId,
            expectedSpec: draft.savedSpec,
            expectedSource: draft.savedSource,
        });
    }

    let conflictOpen = $state(false);

    let lastRecreate = false;

    const reloadMutation = createMutation(() =>
        orpc.resources.pullGitSource.mutationOptions({
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

                if (
                    projectId !== input.projectId ||
                    resourceId !== input.resourceId
                )
                    return;
                draft.accept(updated);
                draft.save.reset();
                deployMutation.reset();
                conflictOpen = false;
            },
        }),
    );

    const deployMutation = createMutation(() =>
        orpc.resources.deploy.mutationOptions({
            onError: (error) => {
                if (
                    error instanceof ORPCError &&
                    error.code === "CONFLICT"
                )
                    conflictOpen = true;
            },
            onSuccess: (deployment, input) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.key(),
                });
                // Deploying may have pushed the draft, which moves the Git revision.
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getResource.queryKey({
                        input: {
                            projectId: input.projectId,
                            resourceId: input.resourceId,
                        },
                    }),
                });

                if (
                    projectId !== input.projectId ||
                    resourceId !== input.resourceId
                )
                    return;
                conflictOpen = false;
                deploymentId = deployment.id;
            },
        }),
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
                !!resource?.draftSpec?.trim() &&
                !draft.isDirty &&
                !draft.busy,
            retry: false,
        }),
    );

    const canDeploy = $derived(
        !!resource &&
            !!project &&
            draft.loaded &&
            !!draft.savedSpec?.trim() &&
            draft.savedSpec === resource.draftSpec &&
            !draft.isDirty &&
            !draft.busy &&
            !resourceQuery.isFetching &&
            formattedComposeQuery.isSuccess &&
            !formattedComposeQuery.isFetching &&
            formattedComposeQuery.data.serviceCount > 0,
    );

    // Why Deploy is disabled, shown on the button so it never just looks broken.
    const deployBlocker = $derived.by(() => {
        if (canDeploy || deployMutation.isPending || !draft.loaded)
            return "";

        if (draft.save.isPending) return "Saving changes…";

        if (draft.isDirty) return "Save changes before deploying";

        if (!draft.savedSpec?.trim())
            return "Add a Compose file before deploying";

        if (draft.busy) return "Another operation is in progress";

        if (
            formattedComposeQuery.isFetching ||
            formattedComposeQuery.isPending
        )
            return "Validating configuration…";

        if (formattedComposeQuery.isError)
            return "Fix the Compose errors below";

        if (formattedComposeQuery.data.serviceCount === 0)
            return "Add at least one service";

        return "Refreshing resource…";
    });

    const saveStatus = $derived(
        draft.save.isPending
            ? "saving"
            : draft.isDirty
              ? "unsaved"
              : hasUndeployedChanges
                ? "saved"
                : "",
    );

    function deploySavedDraft(recreate = false, force = false) {
        if (!canDeploy) return;
        lastRecreate = recreate;
        deployMutation.mutate({
            projectId,
            resourceId,
            recreate,
            force,
        });
    }

    function reloadFromGit() {
        reloadMutation.mutate({
            projectId,
            resourceId,
            expectedSpec: draft.savedSpec,
            expectedSource: draft.savedSource,
        });
    }
</script>

<svelte:head>
    <title>{resource?.name ?? "Resource"} / Stoat</title>
</svelte:head>

{#snippet deployAction()}
    {#if !readOnly && resource?.type !== "bucket" && page.data.isOrganizationAdmin}
        <Tooltip disabled={!deployBlocker && !hasUndeployedChanges}>
            <TooltipTrigger as="span" class="inline-flex">
                <ButtonGroup>
                    <Button
                        onclick={() => deploySavedDraft()}
                        loading={deployMutation.isPending}
                        disabled={!canDeploy}
                    >
                        <span
                            class="inline-flex items-baseline gap-0.5"
                        >
                            Deploy
                            {#if hasUndeployedChanges}
                                <span
                                    class="inline-block origin-center scale-125 leading-none text-warning"
                                    aria-hidden="true"
                                >
                                    *
                                </span>
                                <span class="sr-only">
                                    (undeployed changes)
                                </span>
                            {/if}
                            {#if deployBlocker}
                                <span class="sr-only">
                                    ({deployBlocker})
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
                            <MenuItem
                                onclick={() => deploySavedDraft(true)}
                            >
                                <RefreshCw aria-hidden="true" />
                                Recreate
                            </MenuItem>
                        </MenuPopup>
                    </Menu>
                </ButtonGroup>
            </TooltipTrigger>
            <TooltipPopup side="bottom" sideOffset={8}>
                {deployBlocker || "Undeployed changes"}
            </TooltipPopup>
        </Tooltip>
    {/if}
{/snippet}

<DeployConflictDialog
    bind:open={conflictOpen}
    reloading={reloadMutation.isPending}
    forcing={deployMutation.isPending}
    reloadError={reloadMutation.error?.message}
    onreload={reloadFromGit}
    onforce={() => deploySavedDraft(lastRecreate, true)}
/>

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
                            canEnable={canEnableExternalConnection}
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
                    bind:compose={draft.compose}
                    {readOnly}
                    editorLocked={externalConnectionMutation.isPending ||
                        deployMutation.isPending ||
                        draft.loadedResourceId !== resource.id}
                    {saveStatus}
                    saveError={draft.save.error?.message}
                    deployError={conflictOpen
                        ? undefined
                        : deployMutation.error?.message}
                    composeError={!draft.isDirty &&
                    draft.savedSpec?.trim()
                        ? formattedComposeQuery.error?.message
                        : undefined}
                />
            </div>
        {/if}
    </div>
{/if}
