<script lang="ts">
    import { goto } from "$app/navigation";
    import ProviderIcon from "$lib/components/s3/provider-icon.svelte";
    import { page } from "$app/state";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
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
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import {
        Frame,
        FrameDescription,
        FrameFooter,
        FrameHeader,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/orpc";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import { s3Providers } from "@stoat/s3/providers";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const backHref = $derived(`/projects/${projectId}/create`);

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const connectionsQuery = createQuery(() =>
        orpc.s3.list.queryOptions(),
    );

    const fields = useQueryStates(
        {
            name: parseAsString.withDefault(""),
            bucket: parseAsString,
            connectionId: parseAsString.withDefault(""),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    // Suggest a bucket name from the resource name until one is typed.
    const bucket = $derived(
        fields.bucket.current ??
            fields.name.current
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 63),
    );

    const connections = $derived(connectionsQuery.data ?? []);

    const connection = $derived(
        connections.find(
            (item) => item.id === fields.connectionId.current,
        ) ?? connections[0],
    );

    const createState = createMutation(() =>
        orpc.buckets.create.mutationOptions({
            onSuccess: async (resource) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId },
                    }),
                });
                await goto(`/projects/${projectId}/${resource.id}`);
            },
        }),
    );

    const canSubmit = $derived(
        Boolean(
            fields.name.current.trim() &&
            bucket.length >= 3 &&
            connection &&
            !createState.isPending,
        ),
    );

    function create(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit || !connection) return;

        createState.mutate({
            projectId,
            connectionId: connection.id,
            name: fields.name.current.trim(),
            bucket,
        });
    }
</script>

<svelte:head>
    <title>
        New bucket / {projectQuery.data?.name ?? "Project"} / Stoat
    </title>
</svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
            <Button
                variant="ghost"
                size="icon-sm"
                href={backHref}
                aria-label="Back to new resource"
            >
                <ArrowLeft aria-hidden="true" />
            </Button>
            <HardDrive
                class="size-14 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
            <div class="min-w-0">
                <h1 class="text-2xl font-semibold">New S3 bucket</h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    Stoat creates the bucket and, where the provider
                    allows, access keys limited to it.
                </p>
            </div>
        </div>
        <Badge variant="secondary" size="lg">Storage</Badge>
    </div>

    {#if projectQuery.data?.isInternal}
        <Alert variant="info">
            <AlertDescription>
                Stoat manages this project's internal services. New
                resources can't be added here.
            </AlertDescription>
        </Alert>
    {:else if connectionsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load S3 connections: {connectionsQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if connectionsQuery.isPending}
        <Skeleton
            loading
            loading-label="Loading S3 connections"
            class="mx-auto w-full max-w-2xl"
        >
            <Frame>
                <FrameHeader>
                    <FrameTitle class="text-base">
                        <h2>Bucket</h2>
                    </FrameTitle>
                    <FrameDescription class="mt-1">
                        Provisioning runs in the background.
                    </FrameDescription>
                </FrameHeader>
                <div class="space-y-4 px-5 py-4">
                    {#each ["Name", "Connection", "Bucket name"] as label (label)}
                        <Field>
                            <Label>{label}</Label>
                            <Input readonly />
                        </Field>
                    {/each}
                </div>
                <FrameFooter
                    class="flex items-center justify-end gap-2 px-4 py-3"
                >
                    <Button variant="outline">Cancel</Button>
                    <Button>Create bucket</Button>
                </FrameFooter>
            </Frame>
        </Skeleton>
    {:else if connections.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <HardDrive aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No S3 connections</EmptyTitle>
                <EmptyDescription>
                    Connect a storage provider before provisioning a
                    bucket.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/s3?dialog=create-connection">
                    Add connection
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        <form
            method="POST"
            onsubmit={create}
            aria-busy={createState.isPending}
            class="mx-auto w-full max-w-2xl"
        >
            <Frame role="region" aria-labelledby="bucket-heading">
                <FrameHeader>
                    <FrameTitle class="text-base">
                        <h2 id="bucket-heading">Bucket</h2>
                    </FrameTitle>
                    <FrameDescription class="mt-1">
                        Provisioning runs in the background.
                    </FrameDescription>
                </FrameHeader>
                <div class="space-y-4 px-5 py-4">
                    {#if createState.isError}
                        <Alert variant="error" role="alert">
                            <AlertDescription>
                                {createState.error.message}
                            </AlertDescription>
                        </Alert>
                    {/if}
                    <Field>
                        <Label for="bucket-name" required>Name</Label>
                        <Input
                            id="bucket-name"
                            bind:value={fields.name.current}
                            placeholder="Uploads"
                            autocomplete="off"
                            maxlength={100}
                            disabled={createState.isPending}
                        />
                    </Field>
                    <Field>
                        <Label for="bucket-connection" required>
                            Connection
                        </Label>
                        <Select
                            value={connection?.id}
                            items={connections.map((item) => ({
                                value: item.id,
                                label: item.name,
                            }))}
                            disabled={createState.isPending}
                            onValueChange={(value) =>
                                (fields.connectionId.current =
                                    value ?? "")}
                        >
                            <SelectTrigger id="bucket-connection">
                                {#if connection}
                                    <ProviderIcon
                                        provider={connection.provider}
                                    />
                                {/if}
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {#each connections as item (item.id)}
                                    <SelectItem
                                        value={item.id}
                                        label={item.name}
                                    >
                                        <ProviderIcon
                                            provider={item.provider}
                                        />
                                        {item.name}
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                        {#if connection && !s3Providers[connection.provider].scopedKeys}
                            <FieldDescription>
                                {s3Providers[connection.provider]
                                    .name} can't scope keys, so this bucket
                                shares the connection's access keys.
                            </FieldDescription>
                        {/if}
                    </Field>
                    <Field>
                        <Label for="bucket-bucket" required>
                            Bucket name
                        </Label>
                        <Input
                            id="bucket-bucket"
                            value={bucket}
                            oninput={(event) =>
                                (fields.bucket.current =
                                    event.currentTarget.value)}
                            placeholder="uploads"
                            autocomplete="off"
                            spellcheck="false"
                            class="font-mono"
                            maxlength={63}
                            aria-describedby="bucket-bucket-description"
                            disabled={createState.isPending}
                        />
                        <FieldDescription
                            id="bucket-bucket-description"
                        >
                            3-63 lowercase letters, digits, or
                            hyphens. Names are global on some
                            providers.
                        </FieldDescription>
                    </Field>
                </div>
                <FrameFooter
                    class="mt-auto flex flex-wrap items-center justify-end gap-2 px-4 py-3"
                >
                    <Button
                        variant="outline"
                        href={backHref}
                        disabled={createState.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        loading={createState.isPending}
                        disabled={!canSubmit}
                    >
                        Create bucket
                    </Button>
                </FrameFooter>
            </Frame>
        </form>
    {/if}
</div>
