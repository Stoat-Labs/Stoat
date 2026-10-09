<script lang="ts">
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
    import { formatDate } from "$lib/format";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
    import type { AppRouterClient } from "@stoat/api/routers/index";

    type Cluster = NonNullable<
        Awaited<ReturnType<AppRouterClient["cluster"]["getCluster"]>>
    >;

    let {
        cluster,
        canViewMonitoring,
        retryPending,
        retryError,
        onretry,
        onopendialog,
    }: {
        cluster: Cluster;
        canViewMonitoring: boolean;
        retryPending: boolean;
        retryError: string;
        onretry: () => void;
        onopendialog: (
            dialog: "monitoring" | "retention" | "reinitialize",
        ) => void;
    } = $props();

    const initializationStatus = $derived(
        cluster.initializationStatus ?? "uninitialized",
    );

    const initializationInProgress = $derived(
        ["queued", "running", "retrying"].includes(
            initializationStatus,
        ),
    );

    function statusLabel(status: string) {
        switch (status) {
            case "uninitialized":
                return "Not initialized";
            case "queued":
                return "Queued";
            case "running":
                return "Initializing";
            case "retrying":
                return "Retrying";
            case "failed":
                return "Failed";
            case "ready":
                return "Ready";
            default:
                return status;
        }
    }

    function statusVariant(status: string) {
        switch (status) {
            case "ready":
                return "success";
            case "failed":
                return "error";
            case "uninitialized":
                return "secondary";
            default:
                return "warning";
        }
    }
</script>

<Card>
    <CardHeader
        class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
        <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
                <CardTitle class="text-base">
                    Monitoring stack
                </CardTitle>
                <Badge variant={statusVariant(initializationStatus)}>
                    {statusLabel(initializationStatus)}
                </Badge>
            </div>
            <CardDescription class="mt-1">
                Metrics and logs on the internal network.
            </CardDescription>
            {#if initializationStatus === "ready" && cluster.initializedAt}
                <p class="mt-1 text-xs text-muted-foreground">
                    Initialized {formatDate(cluster.initializedAt)}
                </p>
            {/if}
        </div>
        {#if canViewMonitoring}
            <div class="flex shrink-0 flex-wrap items-center gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => onopendialog("monitoring")}
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
                        onclick={() => onopendialog("retention")}
                    >
                        Edit retention
                    </Button>
                {/if}
            </div>
        </CardPanel>
    {/if}
    {#if initializationStatus !== "ready"}
        <CardPanel class="space-y-3 p-4 pt-0 sm:p-5 sm:pt-0">
            {#if initializationStatus === "uninitialized"}
                <p class="text-sm text-muted-foreground">
                    Initialize the monitoring stack to collect cluster
                    health, metrics, and logs. The stack stays on the
                    internal Uncloud network.
                </p>
            {:else if initializationInProgress}
                <Alert variant="warning">
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>
                        Monitoring initialization is in progress
                    </AlertTitle>
                    <AlertDescription>
                        Stoat is deploying the internal services. This
                        page checks for updates automatically.
                    </AlertDescription>
                </Alert>
            {:else if initializationStatus === "failed"}
                <div class="space-y-3">
                    <Alert variant="error">
                        <CircleAlert aria-hidden="true" />
                        <AlertTitle>
                            Monitoring initialization failed
                        </AlertTitle>
                        <AlertDescription class="break-words">
                            {cluster.initializationError ??
                                "The initialization worker did not provide an error message."}
                        </AlertDescription>
                    </Alert>
                    {#if retryError}
                        <Alert variant="error">
                            <AlertDescription>
                                {retryError}
                            </AlertDescription>
                        </Alert>
                    {/if}
                    {#if cluster.canInitialize}
                        <div class="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                loading={retryPending}
                                disabled={retryPending}
                                onclick={onretry}
                            >
                                Retry initialization
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onclick={() =>
                                    onopendialog("reinitialize")}
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
