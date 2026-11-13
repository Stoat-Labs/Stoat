<script lang="ts">
    import {
        Alert,
        AlertDescription,
        AlertTitle,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { projectHref } from "$lib/api/hrefs";
    import { formatDate } from "$lib/format";
    import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOutIcon";
    import CircleAlert from "phosphor-svelte/lib/WarningCircleIcon";
    import PencilSimple from "phosphor-svelte/lib/PencilSimpleIcon";
    import type { AppRouterClient } from "@clowder/api/routers/index";

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

<Frame class="min-w-0">
    <FrameHeader
        class="flex-row items-center justify-between gap-2 px-2.5 py-3"
    >
        <div class="flex min-w-0 items-center gap-2">
            <FrameTitle>Monitoring</FrameTitle>
            <Badge variant={statusVariant(initializationStatus)}>
                {statusLabel(initializationStatus)}
            </Badge>
        </div>
        {#if canViewMonitoring}
            <Button
                variant="outline"
                size="sm"
                onclick={() => onopendialog("monitoring")}
            >
                Connection details
            </Button>
        {/if}
    </FrameHeader>
    <FramePanel class="flex-1 p-0">
        {#if initializationStatus === "ready"}
            <dl class="divide-y text-sm">
                {#if cluster.retentionDays !== null}
                    <div
                        class="flex h-11 items-center justify-between gap-4 px-4"
                    >
                        <dt class="text-muted-foreground">
                            Retention
                        </dt>
                        <dd class="flex items-center gap-1.5">
                            {cluster.retentionDays} days
                            {#if cluster.canInitialize}
                                <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label="Edit retention"
                                    onclick={() =>
                                        onopendialog("retention")}
                                >
                                    <PencilSimple
                                        aria-hidden="true"
                                    />
                                </Button>
                            {/if}
                        </dd>
                    </div>
                {/if}
                {#if cluster.initializedAt}
                    <div
                        class="flex h-11 items-center justify-between gap-4 px-4"
                    >
                        <dt class="text-muted-foreground">
                            Initialized
                        </dt>
                        <dd>{formatDate(cluster.initializedAt)}</dd>
                    </div>
                {/if}
                {#if cluster.internalProjectId}
                    <div
                        class="flex h-11 items-center justify-between gap-4 px-4"
                    >
                        <dt class="text-muted-foreground">Project</dt>
                        <dd class="min-w-0">
                            <a
                                class="flex min-w-0 items-center gap-1.5 hover:underline"
                                href={projectHref(
                                    cluster.internalProjectId,
                                )}
                            >
                                <span class="truncate">
                                    {cluster.name}-internal
                                </span>
                                <ArrowSquareOut
                                    class="size-3.5 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                />
                            </a>
                        </dd>
                    </div>
                {/if}
            </dl>
        {:else}
            <div class="space-y-3 p-4">
                {#if initializationStatus === "uninitialized"}
                    <p class="text-sm text-muted-foreground">
                        Initialize the monitoring stack to collect
                        cluster health, metrics, and logs. The stack
                        stays on the internal Uncloud network.
                    </p>
                {:else if initializationInProgress}
                    <Alert variant="warning">
                        <CircleAlert aria-hidden="true" />
                        <AlertTitle>
                            Initialization in progress
                        </AlertTitle>
                        <AlertDescription>
                            Clowder is deploying the internal
                            services. This page checks for updates
                            automatically.
                        </AlertDescription>
                    </Alert>
                {:else if initializationStatus === "failed"}
                    <Alert variant="error">
                        <CircleAlert aria-hidden="true" />
                        <AlertTitle>Initialization failed</AlertTitle>
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
                {/if}
            </div>
        {/if}
    </FramePanel>
</Frame>
