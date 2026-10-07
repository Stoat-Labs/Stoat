<script lang="ts">
    import { goto, onNavigate } from "$app/navigation";
    import { page } from "$app/state";
    import ConnectionDialog from "$lib/components/connections/connection-dialog.svelte";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        connectionDialogParsers,
        connectionDialogUrl,
    } from "$lib/params/git-query-params";
    import { orpc } from "$lib/api/orpc";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import { createQuery } from "@tanstack/svelte-query";
    import { useQueryStates } from "nuqs-svelte";
    import { onDestroy, untrack } from "svelte";

    const params = useQueryStates(connectionDialogParsers, {
        history: "replace",
        shallow: true,
        scroll: false,
    });

    const routeId = untrack(() => page.route.id);

    let active = true;

    let leaving = false;

    useHeaderActions(gitActions);

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions(),
    );

    const connections = $derived(
        connectionsQuery.data?.connections ?? [],
    );

    const canManage = $derived(
        connectionsQuery.data?.canManage === true,
    );

    const editingConnection = $derived(
        connections.find(
            (connection) => connection.id === params.edit.current,
        ),
    );

    const connectionDialogOpen = $derived(
        params.dialog.current === "add-connection" ||
            params.dialog.current === "edit-connection",
    );

    const form = $derived.by(() => {
        if (
            !connectionsQuery.data ||
            !canManage ||
            !connectionDialogOpen
        )
            return null;

        if (
            params.dialog.current === "edit-connection" &&
            !editingConnection
        )
            return null;

        return {
            connection:
                params.dialog.current === "edit-connection"
                    ? editingConnection!
                    : null,
            organizationId: connectionsQuery.data.organizationId,
        };
    });

    const formKey = $derived(
        form
            ? `${form.organizationId}:${form.connection?.id ?? "add"}`
            : "",
    );

    const invalidDialog = $derived(
        connectionsQuery.isSuccess &&
            connectionDialogOpen &&
            (!canManage ||
                (params.dialog.current === "edit-connection" &&
                    !editingConnection)),
    );

    const providerNames = {
        github: "GitHub",
        forgejo: "Forgejo",
        generic: "Generic Git server",
    };

    const oauthErrors = {
        configuration:
            "OAuth is not configured for this server. In Add connection (or Edit), select OAuth and set up a new OAuth application. An organization administrator can complete setup there, or use an access token instead.",
        forbidden:
            "Only an organization administrator can authorize a Git account. Check your session and organization.",
        invalid_request:
            "Authorization was cancelled or the provider returned an invalid response. Try connecting again.",
        invalid_state:
            "The authorization session expired or could not be verified. Start authorization again.",
        connection_mismatch:
            "This OAuth application does not match the connection's provider and server.",
        token_exchange_failed:
            "The provider could not complete authorization. Try again or use an access token.",
        invalid_token:
            "The provider did not return usable authorization. Try connecting again.",
        account_failed:
            "The authorized account could not be verified. Check the OAuth application's permissions.",
        failed: "Git account authorization failed. Try again or use an access token.",
    };

    const oauthStatus = $derived(page.url.searchParams.get("oauth"));

    const oauthError = $derived.by(() => {
        if (!oauthStatus || oauthStatus === "success") return "";
        const reason =
            oauthStatus === "error"
                ? (page.url.searchParams.get("reason") ?? "failed")
                : oauthStatus;

        return (
            Object.entries(oauthErrors).find(
                ([code]) => code === reason,
            )?.[1] ?? oauthErrors.failed
        );
    });

    let status = $state("");

    const disabled = $derived(Boolean(form));

    onNavigate((navigation) => {
        leaving = navigation.to?.route.id !== routeId;
    });

    onDestroy(() => {
        active = false;
    });

    async function changeDialog(
        dialog: "add-connection" | "edit-connection" | null,
        edit: string | null = null,
        saved = false,
    ) {
        if (!active || leaving || page.route.id !== routeId) return;

        // goto keeps the mounted form's navigation guard alive until navigation is approved.
        try {
            const url = connectionDialogUrl(
                page.url,
                dialog,
                edit,
                saved,
            );
            await goto(url, {
                replaceState: dialog === null,
                noScroll: true,
                keepFocus: true,
            });

            if (
                saved &&
                active &&
                !leaving &&
                page.route.id === routeId
            ) {
                status =
                    "Account connection saved and access verified. Push permissions and branch protections are checked only when pushing.";
            }
        } catch {
            // A navigation guard may cancel; leave the existing URL and form intact.
        }
    }
</script>

<svelte:head><title>Git / Stoat</title></svelte:head>

{#snippet gitActions()}
    {#if canManage}<Button
            size="sm"
            {disabled}
            onclick={() => changeDialog("add-connection")}
        >
            Add connection
        </Button>{/if}
{/snippet}

<div class="w-full min-w-0 space-y-6 pt-6">
    <p class="text-sm text-muted-foreground">
        Connect Git server accounts and choose their repositories when
        configuring resources.
    </p>
    {#if connectionsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load account connections: {connectionsQuery
                    .error.message}
            </AlertDescription>
        </Alert>
        <Button
            variant="outline"
            disabled={disabled || connectionsQuery.isFetching}
            onclick={() => connectionsQuery.refetch()}
        >
            Retry
        </Button>
    {/if}
    {#if oauthStatus === "success"}<Alert>
            <AlertDescription>
                Git account authorized and connection saved. Choose a
                repository when configuring a resource.
            </AlertDescription>
        </Alert>{/if}
    {#if oauthError}<Alert variant="error">
            <AlertDescription>{oauthError}</AlertDescription>
        </Alert>{/if}
    {#if invalidDialog}
        <Alert variant="error">
            <AlertDescription>
                {canManage
                    ? "This connection is unavailable. It may have been deleted or belong to another organization."
                    : "Only organization owners and administrators can manage account connections."}
            </AlertDescription>
        </Alert>
        <Button variant="outline" onclick={() => changeDialog(null)}>
            Dismiss
        </Button>
    {/if}
    <p class="text-sm text-muted-foreground" role="status">
        {status}
    </p>
    {#if form && canManage}
        {#key formKey}
            {@const identity = formKey}
            <ConnectionDialog
                connection={form.connection}
                organizationId={form.organizationId}
                oauthProviders={connectionsQuery.data
                    ?.oauthProviders ?? []}
                ondone={() => {
                    if (identity === formKey)
                        void changeDialog(null, null, true);
                }}
                oncancel={() => {
                    if (identity === formKey) void changeDialog(null);
                }}
            />
        {/key}
    {/if}
    {#if connectionsQuery.isPending}
        <Skeleton loading loading-label="Loading connections">
            <Frame>
                <FrameHeader>
                    <FrameTitle>Connection name</FrameTitle>
                </FrameHeader>
                <FramePanel class="h-32"></FramePanel>
            </Frame>
        </Skeleton>
    {:else if connections.length === 0 && !connectionsQuery.isError}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <GitBranch aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No Git connections yet</EmptyTitle>
                <EmptyDescription>
                    An administrator can add a connection using OAuth
                    or an access token.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <Frame role="region" aria-labelledby="connections-heading">
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2 id="connections-heading">Connections</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel class="divide-y divide-border p-0">
                {#each connections as connection (connection.id)}
                    <a
                        href={`/git/${connection.id}`}
                        class="group flex items-center gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                    >
                        <span
                            class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"
                        >
                            <ProviderIcon
                                provider={connection.provider}
                            />
                        </span>
                        <span class="min-w-0 flex-1">
                            <span
                                class="block truncate text-sm font-medium"
                            >
                                {connection.name}
                            </span>
                            <span
                                class="block truncate text-xs text-muted-foreground"
                            >
                                {providerNames[connection.provider]} · {connection.serverUrl}
                            </span>
                        </span>
                        <ChevronRight
                            class="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </a>
                {/each}
            </FramePanel>
        </Frame>
    {/if}
</div>
