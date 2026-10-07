<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import ClusterConnectionsFlow from "$lib/components/clusters/cluster-connections-flow.svelte";
    import InitializeClusterDialog from "$lib/components/clusters/initialize-cluster-dialog.svelte";
    import RetentionDialog from "$lib/components/clusters/retention-dialog.svelte";
    import MonitoringConnectionDialog from "$lib/components/clusters/monitoring-connection-dialog.svelte";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import {
        Alert,
        AlertDescription,
        AlertTitle,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
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
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import { orpc, queryClient } from "$lib/orpc";
    import { formatDate } from "$lib/format";
    import { deploymentIdParser } from "$lib/query-params";
    import Activity from "@lucide/svelte/icons/activity";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Check from "@lucide/svelte/icons/check";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import Network from "@lucide/svelte/icons/network";
    import Server from "@lucide/svelte/icons/server";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { Match } from "effect";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import { onDestroy } from "svelte";

    let mounted = true;

    useHeaderActions(clusterActions);

    onDestroy(() => {
        mounted = false;
    });

    const clusterId = $derived(page.params.clusterId ?? "");

    const clusterQuery = createQuery(() => ({
        ...orpc.cluster.getCluster.queryOptions({
            input: { clusterId },
            enabled: clusterId.length > 0,
        }),
        refetchInterval: (query) => {
            const status = query.state.data?.initializationStatus;

            return ["queued", "running", "retrying"].includes(
                status ?? "",
            )
                ? 3000
                : false;
        },
    }));

    const cluster = $derived(clusterQuery.data);

    const diagnostics = $derived(cluster?.diagnostics ?? null);

    const machines = $derived(diagnostics?.machines ?? []);

    const links = $derived(diagnostics?.links ?? []);

    const issues = $derived(diagnostics?.issues ?? []);

    const isHealthy = $derived(diagnostics?.status === "healthy");

    const statusLabel = $derived(
        diagnostics === null
            ? "Unavailable"
            : isHealthy
              ? "Healthy"
              : "Degraded",
    );

    const initializationStatus = $derived(
        cluster?.initializationStatus ?? "uninitialized",
    );

    const initializationInProgress = $derived(
        ["queued", "running", "retrying"].includes(
            initializationStatus,
        ),
    );

    const initializationStatusLabel = $derived(
        Match.value(initializationStatus).pipe(
            Match.when("uninitialized", () => "Not initialized"),
            Match.when("queued", () => "Queued"),
            Match.when("running", () => "Initializing"),
            Match.when("retrying", () => "Retrying"),
            Match.when("failed", () => "Failed"),
            Match.when("ready", () => "Ready"),
            Match.orElse(() => initializationStatus),
        ),
    );

    const initializationStatusVariant = $derived<
        "success" | "warning" | "error" | "secondary"
    >(
        Match.value(initializationStatus).pipe(
            Match.when("ready", () => "success" as const),
            Match.when("failed", () => "error" as const),
            Match.when("uninitialized", () => "secondary" as const),
            Match.orElse(() => "warning" as const),
        ),
    );

    const dialogs = useQueryStates(
        { dialog: parseAsString, deployment: deploymentIdParser },
        { shallow: true, scroll: false },
    );

    const canInitialize = $derived(
        clusterQuery.isSuccess &&
            cluster?.canInitialize === true &&
            initializationStatus === "uninitialized",
    );

    const canReinitialize = $derived(
        clusterQuery.isSuccess &&
            cluster?.canInitialize === true &&
            (initializationStatus === "failed" ||
                initializationStatus === "ready"),
    );

    const canViewMonitoring = $derived(
        clusterQuery.isSuccess &&
            !!cluster &&
            initializationStatus !== "uninitialized",
    );

    const retryMutationState = createMutation(() =>
        orpc.cluster.retryInitialization.mutationOptions({
            onSuccess: async (data, variables) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getCluster.queryKey({
                        input: { clusterId: variables.clusterId },
                    }),
                });

                if (data?.deploymentId)
                    openDeployment(
                        data.deploymentId,
                        variables.clusterId,
                    );
            },
        }),
    );

    // The job runs in the background; the button only confirms it was queued.
    const healthCheckState = createMutation(() =>
        orpc.cluster.runHealthCheck.mutationOptions({
            onSuccess: () => {
                setTimeout(() => healthCheckState.reset(), 4_000);
            },
        }),
    );

    const retryErrorMessage = $derived(
        retryMutationState.error
            ? retryMutationState.error.message ||
                  "Unable to retry initialization."
            : "",
    );

    function stateVariant(
        state: string,
    ): "success" | "warning" | "error" {
        const normalized = state.toLowerCase();

        if (
            ["up", "ready", "running", "healthy"].includes(normalized)
        )
            return "success";

        if (
            ["down", "error", "failed", "unhealthy"].includes(
                normalized,
            )
        )
            return "error";

        return "warning";
    }

    function retryInitialization() {
        if (!clusterId || retryMutationState.isPending) return;
        retryMutationState.mutate({ clusterId });
    }

    function openDeployment(
        deploymentId: string,
        originatingClusterId: string,
    ) {
        if (!mounted || clusterId !== originatingClusterId) return;
        void goto(`/deployments/${deploymentId}`);
    }
</script>

<svelte:head>
    <title>{cluster?.name ?? "Cluster"} / Stoat</title>
</svelte:head>

{#snippet clusterActions()}
    {#if cluster}
        <div class="flex flex-wrap items-center justify-end gap-2">
            {#if healthCheckState.isError}
                <span
                    class="text-sm text-destructive-foreground"
                    role="alert"
                >
                    {healthCheckState.error.message ||
                        "Unable to queue the health check."}
                </span>
            {/if}
            {#if cluster.canInitialize}
                <Button
                    variant="outline"
                    size="sm"
                    loading={healthCheckState.isPending}
                    disabled={healthCheckState.isPending ||
                        healthCheckState.isSuccess}
                    onclick={() =>
                        healthCheckState.mutate({
                            clusterId: cluster.id,
                        })}
                >
                    {#if healthCheckState.isSuccess}
                        <Check aria-hidden="true" />
                        Health check queued
                    {:else}
                        <Activity aria-hidden="true" />
                        Run health check
                    {/if}
                </Button>
            {/if}
            <Button
                variant="outline"
                size="sm"
                href={`/observability?clusters=${cluster.id}`}
            >
                Observability
            </Button>
            {#if canInitialize}
                <Button
                    size="sm"
                    onclick={() =>
                        void dialogs.set({
                            dialog: "initialize",
                            deployment: null,
                        })}
                >
                    Initialize monitoring
                </Button>
            {:else if cluster.canInitialize && initializationStatus === "failed"}
                <Button
                    size="sm"
                    loading={retryMutationState.isPending}
                    disabled={retryMutationState.isPending}
                    onclick={retryInitialization}
                >
                    Retry initialization
                </Button>
            {:else if cluster.canInitialize && initializationStatus === "ready"}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={() =>
                        void dialogs.set({
                            dialog: "reinitialize",
                            deployment: null,
                        })}
                >
                    Reinitialize
                </Button>
            {/if}
            <Badge
                size="lg"
                variant={diagnostics === null
                    ? "error"
                    : isHealthy
                      ? "success"
                      : "warning"}
            >
                {#if isHealthy}
                    <CircleCheck aria-hidden="true" />
                {:else}
                    <CircleAlert aria-hidden="true" />
                {/if}
                {statusLabel}
            </Badge>
        </div>
    {/if}
{/snippet}

<div class="w-full space-y-6 pt-6">
    {#if clusterQuery.isPending}
        <Skeleton loading loading-label="Loading cluster">
            <div class="space-y-6">
                <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {#each ["Health", "Machines", "Connections", "Deployments"] as label (label)}
                        <Card class="rounded-xl">
                            <CardPanel class="p-4">
                                <p
                                    class="text-xs text-muted-foreground"
                                >
                                    {label}
                                </p>
                                <p class="mt-3 text-lg font-semibold">
                                    Current status
                                </p>
                            </CardPanel>
                        </Card>
                    {/each}
                </div>
                <div
                    class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]"
                >
                    <Card class="min-h-80">
                        <CardPanel class="p-5">
                            <h2 class="font-semibold">
                                Connected machines
                            </h2>
                            <p
                                class="mt-2 text-sm text-muted-foreground"
                            >
                                Machine health and runtime details.
                            </p>
                        </CardPanel>
                    </Card>
                    <Card class="min-h-80">
                        <CardPanel class="p-5">
                            <h2 class="font-semibold">
                                Cluster connections
                            </h2>
                            <p
                                class="mt-2 text-sm text-muted-foreground"
                            >
                                Network and monitoring connections.
                            </p>
                        </CardPanel>
                    </Card>
                </div>
            </div>
        </Skeleton>
    {:else if clusterQuery.isError}
        <div class="space-y-4">
            <Alert variant="error">
                <AlertDescription>
                    Unable to load cluster: {clusterQuery.error
                        .message}
                </AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" href="/clusters">
                <ArrowLeft class="size-4" aria-hidden="true" />
                Back to clusters
            </Button>
        </div>
    {:else if !cluster}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <Server aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Cluster not found</EmptyTitle>
                <EmptyDescription>
                    It may have been deleted or belong to another
                    organization.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href="/clusters">
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to clusters
                </Button>
            </EmptyContent>
        </Empty>
    {:else}
        {#if diagnostics}
            <div
                class="grid overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 xl:grid-cols-4"
            >
                <div class="bg-card p-4">
                    <div
                        class="flex items-center gap-2 text-muted-foreground"
                    >
                        <Server class="size-4" aria-hidden="true" />
                        <span class="text-sm">Machines</span>
                    </div>
                    <p class="mt-3 text-2xl font-semibold">
                        {machines.length}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        Reported by the cluster
                    </p>
                </div>
                <div class="bg-card p-4">
                    <div
                        class="flex items-center gap-2 text-muted-foreground"
                    >
                        <Network class="size-4" aria-hidden="true" />
                        <span class="text-sm">Connections</span>
                    </div>
                    <p class="mt-3 text-2xl font-semibold">
                        {links.length}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        Measured machine links
                    </p>
                </div>
                <div class="bg-card p-4">
                    <div
                        class="flex items-center gap-2 text-muted-foreground"
                    >
                        <CircleAlert
                            class="size-4"
                            aria-hidden="true"
                        />
                        <span class="text-sm">Issues</span>
                    </div>
                    <p class="mt-3 text-2xl font-semibold">
                        {issues.length}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        Reported by diagnostics
                    </p>
                </div>
                <div class="bg-card p-4">
                    <div
                        class="flex items-center gap-2 text-muted-foreground"
                    >
                        <GitBranch
                            class="size-4"
                            aria-hidden="true"
                        />
                        <span class="text-sm">Versions</span>
                    </div>
                    <p class="mt-3 text-2xl font-semibold">
                        {diagnostics.versionDrift
                            ? "Drift"
                            : "Aligned"}
                    </p>
                    <p class="mt-1 text-xs text-muted-foreground">
                        Across cluster machines
                    </p>
                </div>
            </div>

            {#if issues.length > 0}
                <Alert variant="warning">
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>
                        Diagnostics reported issues
                    </AlertTitle>
                    <AlertDescription>
                        <ul
                            class="mt-2 space-y-1 text-sm text-muted-foreground"
                        >
                            {#each issues as issue (issue)}
                                <li>{issue}</li>
                            {/each}
                        </ul>
                    </AlertDescription>
                </Alert>
            {/if}

            <div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)]">
                <Frame class="min-w-0">
                    <FrameHeader
                        class="flex-row flex-wrap items-start justify-between gap-3 px-2.5 py-3"
                    >
                        <div class="min-w-0">
                            <FrameTitle>Machines</FrameTitle>
                            <FrameDescription>
                                Members reported by the Uncloud
                                control plane.
                            </FrameDescription>
                        </div>
                        <Badge variant="secondary">
                            {machines.length}
                        </Badge>
                    </FrameHeader>
                    {#if machines.length === 0}
                        <Empty class="p-8 md:py-8">
                            <EmptyHeader>
                                <EmptyDescription>
                                    No machines were reported for this
                                    cluster.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else}
                        <Table variant="card">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Machine</TableHead>
                                    <TableHead>State</TableHead>
                                    <TableHead>Versions</TableHead>
                                    <TableHead class="text-right">
                                        WireGuard
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {#each machines as machine (machine.id)}
                                    <TableRow>
                                        <TableCell class="min-w-48">
                                            <div
                                                class="flex items-center gap-2.5"
                                            >
                                                <Server
                                                    class="flex size-6 shrink-0 items-center justify-center text-muted-foreground rounded-lg"
                                                    aria-hidden="true"
                                                />
                                                <span class="min-w-0">
                                                    <span
                                                        class="block truncate font-medium"
                                                    >
                                                        {machine.name}
                                                    </span>
                                                    {#if machine.error}
                                                        <span
                                                            class="mt-1 block text-xs break-words text-destructive-foreground"
                                                        >
                                                            {machine.error}
                                                        </span>
                                                    {/if}
                                                </span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge
                                                variant={stateVariant(
                                                    machine.state,
                                                )}
                                            >
                                                {machine.state}
                                            </Badge>
                                        </TableCell>
                                        <TableCell class="min-w-36">
                                            <span
                                                class="block text-xs"
                                            >
                                                Daemon {machine.daemonVersion ??
                                                    "Unknown"}
                                            </span>
                                            <span
                                                class="mt-1 block text-xs text-muted-foreground"
                                            >
                                                Docker {machine.dockerVersion ??
                                                    "Unknown"}
                                            </span>
                                        </TableCell>
                                        <TableCell class="text-right">
                                            {#if machine.wireGuard}
                                                <span
                                                    class="inline-flex items-center gap-1.5 text-sm"
                                                >
                                                    <Activity
                                                        class="size-3.5 text-success-foreground"
                                                        aria-hidden="true"
                                                    />
                                                    {machine.wireGuard
                                                        .peers.length} peers
                                                </span>
                                            {:else}
                                                <span
                                                    class="text-xs text-muted-foreground"
                                                >
                                                    Unknown
                                                </span>
                                            {/if}
                                        </TableCell>
                                    </TableRow>
                                {/each}
                            </TableBody>
                        </Table>
                    {/if}
                </Frame>
            </div>

            <Frame class="min-w-0">
                <FrameHeader
                    class="flex-row flex-wrap items-start justify-between gap-3 px-2.5 py-3"
                >
                    <div class="min-w-0">
                        <FrameTitle>Machine connections</FrameTitle>
                        <FrameDescription>
                            Measured paths between machines in the
                            cluster.
                        </FrameDescription>
                    </div>
                    <Badge variant="secondary">{links.length}</Badge>
                </FrameHeader>
                <FramePanel class="overflow-hidden p-0">
                    {#if links.length === 0 && machines.length === 0}
                        <Empty class="p-8 md:py-8">
                            <EmptyHeader>
                                <EmptyDescription>
                                    No machine connections were
                                    reported.
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    {:else}
                        <ClusterConnectionsFlow {machines} {links} />
                    {/if}
                </FramePanel>
            </Frame>
            <Card>
                <CardHeader
                    class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
                >
                    <div class="min-w-0">
                        <div
                            class="flex flex-wrap items-center gap-2"
                        >
                            <CardTitle class="text-base">
                                Monitoring stack
                            </CardTitle>
                            <Badge
                                variant={initializationStatusVariant}
                            >
                                {initializationStatusLabel}
                            </Badge>
                        </div>
                        <CardDescription class="mt-1">
                            Metrics and logs on the internal network.
                        </CardDescription>
                        {#if initializationStatus === "ready" && cluster.initializedAt}
                            <p
                                class="mt-1 text-xs text-muted-foreground"
                            >
                                Initialized {formatDate(
                                    cluster.initializedAt,
                                )}
                            </p>
                        {/if}
                    </div>
                    {#if canViewMonitoring}
                        <div
                            class="flex shrink-0 flex-wrap items-center gap-2"
                        >
                            <Button
                                variant="ghost"
                                size="sm"
                                onclick={() =>
                                    void dialogs.set({
                                        dialog: "monitoring",
                                        deployment: null,
                                    })}
                            >
                                Connection details
                            </Button>
                            {#if cluster.internalProjectId}
                                <Button
                                    variant="outline"
                                    size="sm"
                                    class="max-w-full"
                                    href={`/projects/${cluster.internalProjectId}`}
                                >
                                    <span class="truncate">
                                        Open {cluster.name}-internal
                                    </span>
                                </Button>
                            {/if}
                        </div>
                    {/if}
                </CardHeader>
                {#if initializationStatus === "ready" && cluster.retentionDays !== null}
                    <CardPanel class="p-4 pt-0 sm:p-5 sm:pt-0">
                        <div
                            class="flex flex-wrap items-center justify-between gap-2"
                        >
                            <p class="text-sm text-muted-foreground">
                                Retention <span
                                    class="font-medium text-foreground"
                                >
                                    {cluster.retentionDays} days
                                </span>
                            </p>
                            {#if cluster.canInitialize}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onclick={() =>
                                        dialogs.set({
                                            dialog: "retention",
                                            deployment: null,
                                        })}
                                >
                                    Edit retention
                                </Button>
                            {/if}
                        </div>
                    </CardPanel>
                {/if}
                {#if initializationStatus !== "ready"}
                    <CardPanel
                        class="space-y-3 p-4 pt-0 sm:p-5 sm:pt-0"
                    >
                        {#if initializationStatus === "uninitialized"}
                            <p class="text-sm text-muted-foreground">
                                Initialize the monitoring stack to
                                collect cluster health, metrics, and
                                logs. The stack stays on the internal
                                Uncloud network.
                            </p>
                        {:else if initializationInProgress}
                            <Alert variant="warning">
                                <CircleAlert aria-hidden="true" />
                                <AlertTitle>
                                    Monitoring initialization is in
                                    progress
                                </AlertTitle>
                                <AlertDescription>
                                    Stoat is deploying the internal
                                    services. This page checks for
                                    updates automatically.
                                </AlertDescription>
                            </Alert>
                        {:else if initializationStatus === "failed"}
                            <div class="space-y-3">
                                <Alert variant="error">
                                    <CircleAlert aria-hidden="true" />
                                    <AlertTitle>
                                        Monitoring initialization
                                        failed
                                    </AlertTitle>
                                    <AlertDescription
                                        class="break-words"
                                    >
                                        {cluster.initializationError ??
                                            "The initialization worker did not provide an error message."}
                                    </AlertDescription>
                                </Alert>
                                {#if retryErrorMessage}
                                    <Alert variant="error">
                                        <AlertDescription>
                                            {retryErrorMessage}
                                        </AlertDescription>
                                    </Alert>
                                {/if}
                                {#if cluster.canInitialize}
                                    <div class="flex flex-wrap gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            loading={retryMutationState.isPending}
                                            disabled={retryMutationState.isPending}
                                            onclick={retryInitialization}
                                        >
                                            Retry initialization
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onclick={() =>
                                                void dialogs.set({
                                                    dialog: "reinitialize",
                                                    deployment: null,
                                                })}
                                        >
                                            Edit configuration
                                        </Button>
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </CardPanel>
                {/if}
            </Card>
        {:else}
            <Alert variant="error">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>Diagnostics unavailable</AlertTitle>
                <AlertDescription>
                    The cluster record is available, but its sidecar
                    did not return diagnostics.
                </AlertDescription>
            </Alert>
        {/if}
    {/if}
</div>

<InitializeClusterDialog
    bind:open={
        () =>
            (dialogs.dialog.current === "initialize" &&
                canInitialize) ||
            (dialogs.dialog.current === "reinitialize" &&
                canReinitialize),
        (open) => {
            if (
                mounted &&
                !open &&
                (dialogs.dialog.current === "initialize" ||
                    dialogs.dialog.current === "reinitialize")
            ) {
                void dialogs.set({ dialog: null, deployment: null });
            }
        }
    }
    {clusterId}
    mode={dialogs.dialog.current === "reinitialize"
        ? "reinitialize"
        : "initialize"}
    onInitialized={openDeployment}
/>
<MonitoringConnectionDialog
    bind:open={
        () =>
            dialogs.dialog.current === "monitoring" &&
            canViewMonitoring,
        (open) => {
            if (!open && dialogs.dialog.current === "monitoring") {
                void dialogs.set({ dialog: null, deployment: null });
            }
        }
    }
    {clusterId}
/>
{#if cluster && cluster.retentionDays !== null}
    <RetentionDialog
        bind:open={
            () => dialogs.dialog.current === "retention",
            (open) => {
                if (!open && dialogs.dialog.current === "retention") {
                    void dialogs.set({
                        dialog: null,
                        deployment: null,
                    });
                }
            }
        }
        {clusterId}
        currentDays={cluster.retentionDays}
    />
{/if}
