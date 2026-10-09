<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import ConnectionFields from "$lib/components/s3/connection-fields.svelte";
    import ProviderIcon from "$lib/components/s3/provider-icon.svelte";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import {
        Frame,
        FrameDescription,
        FrameFooter,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        s3BucketStatusVariant,
        s3ConnectionInput,
        s3DraftComplete,
        type S3ConnectionDraft,
    } from "$lib/s3";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import { s3Providers } from "@stoat/s3/providers";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { watch } from "runed";

    const connectionId = $derived(page.params.connectionId ?? "");

    const connectionQuery = createQuery(() =>
        orpc.s3.get.queryOptions({
            input: { connectionId },
            enabled: Boolean(connectionId),
        }),
    );

    const connection = $derived(connectionQuery.data);

    // Members see the connection; only admins change, test, or delete it.
    const canManage = $derived(
        page.data.isOrganizationAdmin === true,
    );

    let name = $state("");

    let draft = $state<S3ConnectionDraft>({
        endpoint: "",
        region: "us-east-1",
        forcePathStyle: false,
        accountId: "",
        accessKey: "",
        secretKey: "",
        apiToken: "",
    });

    let deleteOpen = $state(false);

    // Reset the form whenever a different saved version arrives.
    watch(
        () => connection && `${connection.id}:${connection.version}`,
        () => {
            if (!connection) return;

            name = connection.name;
            draft = {
                endpoint: connection.endpoint,
                region: connection.region,
                forcePathStyle: connection.forcePathStyle,
                accountId: connection.accountId ?? "",
                accessKey: "",
                secretKey: "",
                apiToken: "",
            };
        },
    );

    function refresh() {
        return Promise.all([
            queryClient.invalidateQueries({
                queryKey: orpc.s3.get.queryKey({
                    input: { connectionId },
                }),
            }),
            queryClient.invalidateQueries({
                queryKey: orpc.s3.list.queryKey(),
            }),
        ]);
    }

    const saveState = createMutation(() =>
        orpc.s3.update.mutationOptions({ onSuccess: refresh }),
    );

    const testState = createMutation(() =>
        orpc.s3.test.mutationOptions({ onSuccess: refresh }),
    );

    const removeState = createMutation(() =>
        orpc.s3.remove.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.s3.list.queryKey(),
                });
                await goto("/s3");
            },
        }),
    );

    const pending = $derived(
        saveState.isPending || testState.isPending,
    );

    const complete = $derived(
        connection
            ? s3DraftComplete(connection.provider, draft, false)
            : false,
    );

    function save(event: SubmitEvent) {
        event.preventDefault();

        if (!connection || !complete || !name.trim() || pending)
            return;

        testState.reset();
        saveState.mutate({
            connectionId: connection.id,
            version: connection.version,
            name: name.trim(),
            connection: s3ConnectionInput(connection.provider, draft),
        });
    }

    function test() {
        if (!connection || !complete) return;

        saveState.reset();
        testState.mutate({
            connectionId: connection.id,
            version: connection.version,
            connection: s3ConnectionInput(connection.provider, draft),
        });
    }
</script>

<svelte:head>
    <title>{connection?.name ?? "S3 connection"} / Stoat</title>
</svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    {#if connectionQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load the connection: {connectionQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if !connection}
        <Skeleton loading loading-label="Loading connection">
            <div class="flex flex-col gap-6">
                <div class="flex items-start gap-3">
                    <span class="size-8 shrink-0 rounded-lg"></span>
                    <span class="size-14 shrink-0 rounded-lg"></span>
                    <div>
                        <h1 class="text-2xl font-semibold">
                            Connection name
                        </h1>
                        <p class="mt-1 text-sm">
                            Provider · https://s3.example.com
                        </p>
                    </div>
                </div>
                <div class="grid items-start gap-6 xl:grid-cols-5">
                    <Frame class="min-w-0 xl:col-span-3">
                        <FrameHeader>
                            <FrameTitle class="text-base">
                                <h2>Connection</h2>
                            </FrameTitle>
                            <FrameDescription class="mt-1">
                                Changing the endpoint or account
                                requires the credentials again.
                            </FrameDescription>
                        </FrameHeader>
                        <div class="space-y-4 px-5 py-4">
                            {#each ["Name", "Endpoint", "Region", "Access key", "Secret key"] as label (label)}
                                <Field>
                                    <Label>{label}</Label>
                                    <Input readonly />
                                </Field>
                            {/each}
                        </div>
                        <FrameFooter
                            class="flex items-center justify-between gap-2 px-4 py-3"
                        >
                            <Button variant="destructive-outline">
                                Delete
                            </Button>
                            <div class="flex gap-2">
                                <Button variant="outline">
                                    Test connection
                                </Button>
                                <Button>Save</Button>
                            </div>
                        </FrameFooter>
                    </Frame>
                    <Frame class="min-w-0 xl:col-span-2">
                        <FrameHeader>
                            <FrameTitle class="text-base">
                                <h2>Buckets</h2>
                            </FrameTitle>
                            <FrameDescription class="mt-1">
                                Add a bucket from a project's New
                                resource page.
                            </FrameDescription>
                        </FrameHeader>
                        <FramePanel
                            class="divide-y divide-border p-0"
                        >
                            {#each { length: 2 }, index (index)}
                                <div class="p-4">
                                    <p class="font-mono text-sm">
                                        bucket-name
                                    </p>
                                    <p class="text-xs">
                                        Project / resource
                                    </p>
                                </div>
                            {/each}
                        </FramePanel>
                    </Frame>
                </div>
            </div>
        </Skeleton>
    {:else}
        <div class="flex items-start gap-3">
            <Button
                variant="ghost"
                size="icon-sm"
                href="/s3"
                aria-label="Back to S3 connections"
            >
                <ArrowLeft aria-hidden="true" />
            </Button>
            <ProviderIcon
                provider={connection.provider}
                class="size-14"
            />
            <div class="min-w-0">
                <h1 class="text-2xl font-semibold break-anywhere">
                    {connection.name}
                </h1>
                <p class="mt-1 text-sm text-muted-foreground">
                    {s3Providers[connection.provider].name} · {connection.endpoint}
                </p>
            </div>
        </div>

        <div class="grid items-start gap-6 xl:grid-cols-5">
            <form
                method="POST"
                onsubmit={save}
                aria-busy={pending}
                class="flex min-w-0 xl:col-span-3"
            >
                <Frame
                    class="min-w-0 flex-1"
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
                            Changing the endpoint or account requires
                            the credentials again.
                        </FrameDescription>
                    </FrameHeader>
                    <div class="space-y-4 px-5 py-4">
                        {#if saveState.isError}
                            <Alert variant="error" role="alert">
                                <AlertDescription>
                                    {saveState.error.message}
                                </AlertDescription>
                            </Alert>
                        {/if}
                        {#if testState.isError}
                            <Alert variant="error" role="alert">
                                <AlertDescription>
                                    {testState.error.message}
                                </AlertDescription>
                            </Alert>
                        {:else if testState.data}
                            <Alert
                                variant={testState.data.success
                                    ? "success"
                                    : "error"}
                                role="status"
                            >
                                <AlertDescription>
                                    {testState.data.message}
                                </AlertDescription>
                            </Alert>
                        {:else if connection.lastTestStatus === "failure"}
                            <Alert variant="error">
                                <AlertDescription>
                                    Last test failed: {connection.lastTestError}
                                </AlertDescription>
                            </Alert>
                        {/if}
                        <Field>
                            <Label for="s3-name" required>Name</Label>
                            <Input
                                id="s3-name"
                                bind:value={name}
                                autocomplete="off"
                                maxlength={100}
                                disabled={pending || !canManage}
                            />
                        </Field>
                        <ConnectionFields
                            provider={connection.provider}
                            editing
                            disabled={pending || !canManage}
                            bind:endpoint={draft.endpoint}
                            bind:region={draft.region}
                            bind:forcePathStyle={draft.forcePathStyle}
                            bind:accountId={draft.accountId}
                            bind:accessKey={draft.accessKey}
                            bind:secretKey={draft.secretKey}
                            bind:apiToken={draft.apiToken}
                        />
                    </div>
                    {#if canManage}
                        <FrameFooter
                            class="mt-auto flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                        >
                            <Button
                                variant="destructive-outline"
                                onclick={() => {
                                    removeState.reset();
                                    deleteOpen = true;
                                }}
                                disabled={pending}
                            >
                                Delete
                            </Button>
                            <div class="flex flex-wrap gap-2">
                                <Button
                                    variant="outline"
                                    onclick={test}
                                    loading={testState.isPending}
                                    disabled={!complete || pending}
                                >
                                    Test connection
                                </Button>
                                <Button
                                    type="submit"
                                    loading={saveState.isPending}
                                    disabled={!complete ||
                                        !name.trim() ||
                                        pending}
                                >
                                    Save
                                </Button>
                            </div>
                        </FrameFooter>
                    {/if}
                </Frame>
            </form>

            <Frame
                class="min-w-0 xl:col-span-2"
                role="region"
                aria-labelledby="buckets-heading"
            >
                <FrameHeader>
                    <div class="flex items-baseline gap-2">
                        <FrameTitle class="text-base">
                            <h2 id="buckets-heading">Buckets</h2>
                        </FrameTitle>
                        <span
                            class="text-xs tabular-nums text-muted-foreground"
                        >
                            {connection.buckets.length}
                        </span>
                    </div>
                    <FrameDescription class="mt-1">
                        Add a bucket from a project's New resource
                        page.
                    </FrameDescription>
                </FrameHeader>
                <FramePanel class="divide-y divide-border p-0">
                    {#each connection.buckets as bucket (bucket.resourceId)}
                        <a
                            href={`/projects/${bucket.projectId}/${bucket.resourceId}`}
                            class="flex items-center gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                        >
                            <span class="min-w-0 flex-1">
                                <span
                                    class="block truncate font-mono text-sm"
                                >
                                    {bucket.name}
                                </span>
                                <span
                                    class="block truncate text-xs text-muted-foreground"
                                >
                                    {bucket.projectName} / {bucket.resourceName}
                                </span>
                            </span>
                            {#if bucket.status !== "ready"}
                                <Badge
                                    variant={s3BucketStatusVariant[
                                        bucket.status
                                    ]}
                                    class="capitalize"
                                >
                                    {bucket.status}
                                </Badge>
                            {/if}
                            <ChevronRight
                                class="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                        </a>
                    {:else}
                        <p class="p-4 text-sm text-muted-foreground">
                            No buckets yet.
                        </p>
                    {/each}
                </FramePanel>
            </Frame>
        </div>

        <ConfirmDialog
            bind:open={deleteOpen}
            title={`Delete ${connection.name}?`}
            description="Stoat forgets this connection and its credentials. Nothing is deleted at the provider."
            confirmLabel="Delete connection"
            pending={removeState.isPending}
            error={removeState.error?.message ?? ""}
            onconfirm={() =>
                removeState.mutate({
                    connectionId: connection.id,
                    version: connection.version,
                })}
        />
    {/if}
</div>
