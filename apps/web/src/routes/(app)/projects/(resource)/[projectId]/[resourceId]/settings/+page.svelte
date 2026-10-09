<script lang="ts">
    import { page } from "$app/state";
    import ResourceComposeSettings from "$lib/components/projects/resource-compose-settings.svelte";
    import ResourceDangerZone from "$lib/components/projects/resource-danger-zone.svelte";
    import ResourceGeneralSettings from "$lib/components/projects/resource-general-settings.svelte";
    import ResourceSourceSettings from "$lib/components/projects/resource-source-settings.svelte";
    import BucketDangerZone from "$lib/components/s3/bucket-danger-zone.svelte";
    import BucketStorageLimit from "$lib/components/s3/bucket-storage-limit.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Label } from "$lib/components/ui/label";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import Boxes from "@lucide/svelte/icons/boxes";
    import { createQuery } from "@tanstack/svelte-query";

    const projectId = $derived(page.params.projectId ?? "");

    const resourceId = $derived(page.params.resourceId ?? "");

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: Boolean(projectId && resourceId),
        }),
    );

    // Internal (system-managed) resources cannot be deleted.
    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: Boolean(projectId),
        }),
    );
</script>

<svelte:head>
    <title>
        Settings / {resourceQuery.data?.name ?? "Resource"} / Stoat
    </title>
</svelte:head>

<div class="mx-auto w-full max-w-5xl space-y-8 pt-6 sm:pt-8">
    {#if resourceQuery.isPending}
        <Skeleton loading loading-label="Loading resource settings">
            <div class="space-y-8">
                <div class="grid gap-8 md:grid-cols-3">
                    <div>
                        <h2 class="text-lg font-semibold">General</h2>
                        <p class="mt-1 text-sm text-muted-foreground">
                            Update the resource name, description, and
                            icon.
                        </p>
                    </div>
                    <Card class="md:col-span-2">
                        <CardPanel class="space-y-5 p-6">
                            <div>
                                <Label>Resource name</Label>
                                <p class="mt-2 text-sm">
                                    Resource service
                                </p>
                            </div>
                            <div>
                                <Label>Description</Label>
                                <p class="mt-2 text-sm">
                                    Resource configuration and
                                    deployment settings.
                                </p>
                            </div>
                        </CardPanel>
                    </Card>
                </div>
            </div>
        </Skeleton>
    {:else if resourceQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load resource settings: {resourceQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if !resourceQuery.data}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Boxes aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Resource not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another
                    organization.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <ResourceGeneralSettings {projectId} {resourceId} />

        {#if resourceQuery.data.type === "bucket"}
            <BucketStorageLimit {projectId} {resourceId} />
            <BucketDangerZone
                {projectId}
                {resourceId}
                name={resourceQuery.data.name}
            />
        {:else}
            <ResourceComposeSettings {projectId} {resourceId} />
            {#if projectQuery.data && !projectQuery.data.isInternal}
                <ResourceSourceSettings {projectId} {resourceId} />
                <ResourceDangerZone
                    {projectId}
                    {resourceId}
                    name={resourceQuery.data.name}
                />
            {/if}
        {/if}
    {/if}
</div>
