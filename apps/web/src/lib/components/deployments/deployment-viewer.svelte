<script lang="ts">
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import LogViewer from "$lib/components/shared/log-viewer.svelte";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameHeader,
        FramePanel,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Spinner } from "$lib/components/ui/spinner";
    import { subscribeToStream } from "$lib/deployments/stream";
    import {
        deploymentStatusLabel,
        deploymentStatusVariant,
        isActiveDeploymentStatus,
        isTerminalDeploymentStatus,
    } from "$lib/deployments/status";
    import { formatDurationMs } from "$lib/format";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { classifyLog, type LogRow } from "$lib/resources/logs";
    import { deploymentSteps } from "$lib/deployments/steps";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import Download from "@lucide/svelte/icons/download";
    import { createMutation } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";
    import { untrack, tick } from "svelte";
    import DeploymentTimeline from "./deployment-timeline.svelte";

    useHeaderActions(cancelAction);

    type DeploymentEvent =
        Awaited<
            ReturnType<typeof client.cluster.streamDeployment>
        > extends AsyncIterable<infer T>
            ? T
            : never;

    type ViewerRow = LogRow & { event?: string };

    let { deploymentId }: { deploymentId: string } = $props();

    let deployment = $state<DeploymentEvent["deployment"] | null>(
        null,
    );

    let rows = $state.raw<ViewerRow[]>([]);

    let cancelAllowed = $state(false);

    let streamError = $state("");

    let reconnecting = $state(false);

    const view = useQueryStates(
        {
            deploymentQuery: parseAsString.withDefault(""),
            deploymentDebug: parseAsBoolean.withDefault(false),
            deploymentWrap: parseAsBoolean.withDefault(true),
            deploymentFollowing: parseAsBoolean.withDefault(true),
        },
        { shallow: true, scroll: false, history: "replace" },
    );

    let copied = $state(false);

    let now = $state(Date.now());

    function toRow(line: DeploymentEvent["logs"][number]): ViewerRow {
        const level = line.metadata?.level ?? "info";
        const time = new Date(line.createdAt).getTime();

        return {
            id: line.id,
            key: String(line.id),
            time,
            timestamp: new Date(time).toISOString(),
            message: line.text,
            level:
                level === "error" ? "error" : classifyLog(line.text),
            label: level === "debug" ? "debug" : undefined,
            muted: level === "debug",
            event: line.metadata?.event,
        };
    }

    const visibleLogs = $derived.by(() => {
        const needle = view.deploymentQuery.current
            .trim()
            .toLowerCase();

        return rows.filter(
            (row) =>
                (view.deploymentDebug.current || !row.muted) &&
                (!needle ||
                    row.message.toLowerCase().includes(needle)),
        );
    });

    $effect(() => {
        const id = deploymentId;

        if (!id) return;

        deployment = null;
        rows = [];
        cancelAllowed = false;
        streamError = "";
        reconnecting = false;
        // The nuqs setter reads its own state; tracking it would restart the stream on every view change.
        untrack(() => {
            view.deploymentFollowing.current = true;
            cancelMutationState.reset();
        });
        let disposed = false;
        let stopStream: (() => void) | undefined;
        let afterId = 0;
        let completed = false;
        let streamComplete = false;
        const rawLogs: DeploymentEvent["logs"] = [];

        // IDs are ordered by the server, including chunked replay and reconnects.
        function appendLines(lines: DeploymentEvent["logs"]) {
            const fresh = lines.filter((line) => line.id > afterId);

            if (!fresh.length) return;
            rows = rows.concat(fresh.map(toRow));
            rawLogs.push(...fresh);
            afterId = fresh.at(-1)!.id;
        }

        function startStream() {
            stopStream = subscribeToStream(
                (signal) =>
                    client.cluster.streamDeployment(
                        { deploymentId: id, afterId },
                        { signal },
                    ),
                (event) => {
                    if (disposed) return;
                    streamComplete = event.complete;
                    deployment = event.deployment;
                    cancelAllowed = event.canCancel;
                    streamError = "";
                    reconnecting = false;
                    appendLines(event.logs);

                    if (
                        !completed &&
                        isTerminalDeploymentStatus(
                            event.deployment.status,
                        )
                    ) {
                        completed = true;
                        // Cache the finished deployment so revisits render without a stream.
                        // Narrow invalidation keeps this entry fresh while lists still refresh.
                        queryClient.setQueryData(
                            orpc.cluster.getDeployment.queryKey({
                                input: { deploymentId: id },
                            }),
                            {
                                ...event.deployment,
                                logs: rawLogs,
                                canCancel: event.canCancel,
                            },
                        );
                        void queryClient.invalidateQueries({
                            queryKey:
                                orpc.cluster.listAllDeployments.key(),
                        });
                        void queryClient.invalidateQueries({
                            queryKey:
                                orpc.cluster.listDeployments.key(),
                        });
                        void queryClient.invalidateQueries({
                            queryKey:
                                orpc.cluster.getCluster.queryKey({
                                    input: {
                                        clusterId:
                                            event.deployment
                                                .clusterId,
                                    },
                                }),
                        });

                        if (event.deployment.resourceId) {
                            void queryClient.invalidateQueries({
                                queryKey: orpc.resources.key(),
                            });
                        }
                    }
                },
                (error, retrying) => {
                    if (disposed) return;
                    streamError =
                        error.message ||
                        "Unable to stream deployment logs.";
                    reconnecting = retrying;
                },
                () => streamComplete,
            );
        }

        // Cache-first: finished deployments render from getDeployment without ever
        // opening a stream; active ones seed from it, then follow deltas via afterId.
        void queryClient
            .fetchQuery(
                orpc.cluster.getDeployment.queryOptions({
                    input: { deploymentId: id },
                    staleTime: Infinity,
                    gcTime: 30 * 60_000,
                    retry: false,
                }),
            )
            .then((snapshot) => {
                if (disposed) return;

                const {
                    logs: snapshotLogs,
                    canCancel: snapshotCanCancel,
                    ...snapshotDeployment
                } = snapshot;

                deployment = snapshotDeployment;
                cancelAllowed = snapshotCanCancel;
                rows = snapshotLogs.map(toRow);
                rawLogs.push(...snapshotLogs);
                afterId = snapshotLogs.at(-1)?.id ?? 0;

                if (
                    isTerminalDeploymentStatus(
                        snapshotDeployment.status,
                    )
                ) {
                    completed = true;

                    return;
                }

                startStream();
            })
            .catch(() => {
                if (!disposed) startStream();
            });

        return () => {
            disposed = true;
            stopStream?.();
        };
    });

    const status = $derived(deployment?.status ?? "queued");

    const isActive = $derived(isActiveDeploymentStatus(status));

    // A queued deployment carrying an error is waiting for its next attempt.
    const retrying = $derived(
        status === "queued" && !!deployment?.error,
    );

    const statusLabel = $derived(
        deploymentStatusLabel(status, retrying),
    );

    const statusVariant = $derived(deploymentStatusVariant(status));

    const title = $derived(
        deployment?.name === "DeployResource"
            ? "Resource deployment"
            : deployment?.name === "InitializeCluster"
              ? "Cluster initialization"
              : (deployment?.name ?? "Deployment"),
    );

    const canCancel = $derived(cancelAllowed && isActive);

    const raw = $derived(view.deploymentDebug.current);

    const steps = $derived(
        deploymentSteps(
            rows.filter((row) => !row.muted),
            isActive,
        ),
    );

    const visibleSteps = $derived.by(() => {
        const needle = view.deploymentQuery.current
            .trim()
            .toLowerCase();

        if (!needle) return steps;

        return steps.filter((step) =>
            [
                step.title,
                step.label,
                step.machine,
                step.detail,
                ...step.history,
                ...step.ops.flatMap((op) => [op.title, op.detail]),
            ]
                .join(" ")
                .toLowerCase()
                .includes(needle),
        );
    });

    let stepsViewport = $state<HTMLDivElement>();

    $effect(() => {
        void visibleSteps.at(-1)?.history.length;
        void visibleSteps.length;
        void status;

        if (!stepsViewport || !view.deploymentFollowing.current)
            return;
        const node = stepsViewport;
        void tick().then(() => (node.scrollTop = node.scrollHeight));
    });

    function onStepsScroll() {
        if (!stepsViewport) return;

        const atBottom =
            stepsViewport.scrollHeight -
                stepsViewport.scrollTop -
                stepsViewport.clientHeight <
            40;

        if (view.deploymentFollowing.current !== atBottom)
            view.deploymentFollowing.current = atBottom;
    }

    const startedAt = $derived(
        deployment ? new Date(deployment.createdAt).getTime() : 0,
    );

    const durationMs = $derived(
        deployment
            ? Math.max(
                  0,
                  (deployment.finishedAt
                      ? new Date(deployment.finishedAt).getTime()
                      : now) - startedAt,
              )
            : null,
    );

    $effect(() => {
        if (!isActive) return;
        const timer = setInterval(() => (now = Date.now()), 1000);

        return () => clearInterval(timer);
    });

    // Elapsed since the deployment started, e.g. 00:07 or 01:02:07.
    function offset(value: Date | string) {
        const ms = Math.max(0, new Date(value).getTime() - startedAt);

        return new Date(ms)
            .toISOString()
            .slice(ms >= 3_600_000 ? 11 : 14, 19);
    }

    function plainText() {
        return visibleLogs
            .map(
                (row) =>
                    `${row.timestamp} ${(row.label ?? (row.level === "error" ? "error" : "info")).toUpperCase().padEnd(5)} ${row.message}`,
            )
            .join("\n");
    }

    async function copyLogs() {
        try {
            await navigator.clipboard.writeText(plainText());
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // Clipboard denial leaves the visible Copy button for manual retry.
        }
    }

    function downloadLogs() {
        const url = URL.createObjectURL(
            new Blob([plainText() + "\n"], { type: "text/plain" }),
        );

        const link = document.createElement("a");
        link.href = url;
        link.download = `deployment-${deploymentId}.log`;
        link.click();
        URL.revokeObjectURL(url);
    }

    const cancelMutationState = createMutation(() =>
        orpc.cluster.cancelDeployment.mutationOptions({
            onSuccess: (_data, input) => {
                if (deploymentId === input.deploymentId)
                    cancelAllowed = false;
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listDeployments.key(),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getDeployment.queryKey({
                        input: { deploymentId: input.deploymentId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });
            },
        }),
    );

    function cancelDeployment() {
        if (
            !deploymentId ||
            !canCancel ||
            cancelMutationState.isPending
        )
            return;
        cancelMutationState.mutate({ deploymentId });
    }
</script>

<svelte:head><title>{title} / Stoat</title></svelte:head>

{#snippet cancelAction()}
    {#if canCancel}
        <Button
            variant="destructive-outline"
            size="sm"
            loading={cancelMutationState.isPending}
            disabled={cancelMutationState.isPending}
            onclick={cancelDeployment}
        >
            Cancel deployment
        </Button>
    {/if}
{/snippet}

{#snippet logActions()}
    <Button
        variant={raw ? "secondary" : "ghost"}
        size="xs"
        class="gap-1.5 text-xs"
        aria-pressed={raw}
        title={raw
            ? "Show deployment steps"
            : "Show every raw log line, including debug output"}
        onclick={() => (view.deploymentDebug.current = !raw)}
    >
        Raw logs
        <span class="font-mono tabular-nums text-muted-foreground">
            {rows.length}
        </span>
    </Button>
    <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy logs"
        title="Copy logs"
        disabled={!visibleLogs.length}
        onclick={copyLogs}
    >
        {#if copied}<Check
                class="size-3.5"
                aria-hidden="true"
            />{:else}<Copy class="size-3.5" aria-hidden="true" />{/if}
    </Button>
    <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Download logs"
        title="Download logs"
        disabled={!visibleLogs.length}
        onclick={downloadLogs}
    >
        <Download class="size-3.5" aria-hidden="true" />
    </Button>
{/snippet}

{#snippet emptyState()}
    <Empty class="h-full">
        <EmptyHeader>
            <EmptyTitle>
                {rows.length
                    ? "No matching lines"
                    : !deployment || isActive
                      ? "Waiting for output"
                      : "No logs recorded"}
            </EmptyTitle>
            <EmptyDescription>
                {rows.length
                    ? "Clear the filter to see all lines."
                    : !deployment || isActive
                      ? "Deployment output appears here as it runs."
                      : "This deployment finished without output."}
            </EmptyDescription>
        </EmptyHeader>
    </Empty>
{/snippet}

<div
    class="flex h-[calc(100dvh-7rem)] min-h-120 w-full min-w-0 flex-col pt-3 xl:h-auto xl:min-h-0 xl:flex-1"
>
    <Frame class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <FrameHeader class="shrink-0 gap-2 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
                <h1 class="text-sm font-medium">{title}</h1>
                {#if deployment}
                    <span role="status">
                        <Badge variant={statusVariant}>
                            {#if isActive && !retrying}<Spinner
                                    aria-hidden="true"
                                />{/if}
                            {statusLabel}
                        </Badge>
                    </span>
                {/if}
                {#if durationMs !== null}<span
                        class="text-xs text-muted-foreground"
                    >
                        · {formatDurationMs(durationMs)}
                    </span>{/if}
                {#if cancelMutationState.error}<span
                        class="text-xs text-destructive-foreground"
                    >
                        {cancelMutationState.error?.message ??
                            "Unable to cancel."}
                    </span>{/if}
            </div>
            <div class="flex items-center gap-1">
                <Input
                    size="sm"
                    type="search"
                    aria-label="Filter logs"
                    placeholder="Filter logs..."
                    bind:value={
                        () => view.deploymentQuery.current,
                        (value) =>
                            (view.deploymentQuery.current = value)
                    }
                />
                {@render logActions()}
            </div>
        </FrameHeader>
        <FramePanel
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0"
        >
            {#if raw}
                <LogViewer
                    logs={visibleLogs}
                    label="Deployment logs"
                    timeWidth="8ch"
                    formatTime={offset}
                    highlight={view.deploymentQuery.current}
                    start={deployment ? startedAt : undefined}
                    end={deployment?.finishedAt
                        ? new Date(deployment.finishedAt).getTime()
                        : undefined}
                    bind:wrap={
                        () => view.deploymentWrap.current,
                        (value) =>
                            (view.deploymentWrap.current = value)
                    }
                    bind:following={
                        () => view.deploymentFollowing.current,
                        (value) =>
                            (view.deploymentFollowing.current = value)
                    }
                    empty={emptyState}
                />
            {:else}
                <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must support keyboard scrolling.) -->
                <div
                    bind:this={stepsViewport}
                    class="min-h-0 flex-1 overflow-auto bg-code p-4 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-black/20"
                    tabindex="0"
                    role="region"
                    aria-label="Condensed deployment logs"
                    onscroll={onStepsScroll}
                >
                    {#if !deployment}
                        <Skeleton
                            loading
                            loading-label="Loading deployment"
                            background-color="color-mix(in oklab, var(--foreground) 8%, transparent)"
                            shimmer-color="color-mix(in oklab, var(--foreground) 6%, transparent)"
                        >
                            {#each [60, 85, 45, 70, 55] as width, index (index)}
                                <p
                                    class="py-0.5"
                                    style:width={`${width}%`}
                                >
                                    Loading deployment output
                                </p>
                            {/each}
                        </Skeleton>
                    {:else if !visibleSteps.length && (isActive || !rows.length || view.deploymentQuery.current)}
                        {@render emptyState()}
                    {:else}
                        {#if deployment && durationMs !== null}
                            <DeploymentTimeline
                                steps={visibleSteps}
                                {now}
                                {startedAt}
                                active={isActive}
                                {retrying}
                                {status}
                                name={deployment.name}
                                error={deployment.error}
                                {durationMs}
                                outcomeAt={new Date(
                                    retrying
                                        ? deployment.updatedAt
                                        : (deployment.finishedAt ??
                                              deployment.updatedAt),
                                ).getTime()}
                            />
                        {/if}
                    {/if}
                </div>
            {/if}

            <div
                class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground"
            >
                <span>Time since start</span>
                <span
                    class="min-w-0 truncate font-mono"
                    title={deploymentId}
                >
                    {deploymentId}
                </span>
            </div>
        </FramePanel>
    </Frame>
</div>
