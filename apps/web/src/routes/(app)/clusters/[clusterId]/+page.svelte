<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import ClusterConnectionsFlow from "$lib/components/clusters/cluster-connections-flow.svelte";
    import ClusterMachinesTable from "$lib/components/clusters/cluster-machines-table.svelte";
    import ClusterMonitoringCard from "$lib/components/clusters/cluster-monitoring-card.svelte";
    import ClusterSummaryStrip from "$lib/components/clusters/cluster-summary-strip.svelte";
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
    import { Card, CardPanel } from "$lib/components/ui/card";
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
    import { orpc, queryClient } from "$lib/api/orpc";
    import { deploymentIdParser } from "$lib/params/query-params";
    import Activity from "@lucide/svelte/icons/activity";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Check from "@lucide/svelte/icons/check";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import Server from "@lucide/svelte/icons/server";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
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

    function openDialog(
        dialog:
            | "initialize"
            | "reinitialize"
            | "monitoring"
            | "retention",
    ) {
        void dialogs.set({ dialog, deployment: null });
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
                    onclick={() => openDialog("initialize")}
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
                    onclick={() => openDialog("reinitialize")}
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
            <ClusterSummaryStrip
                machineCount={machines.length}
                linkCount={links.length}
                issueCount={issues.length}
                versionDrift={diagnostics.versionDrift}
            />

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
                <ClusterMachinesTable {machines} />
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

            <ClusterMonitoringCard
                {cluster}
                {canViewMonitoring}
                retryPending={retryMutationState.isPending}
                retryError={retryErrorMessage}
                onretry={retryInitialization}
                onopendialog={openDialog}
            />
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
