<script lang="ts">
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import LogViewer from "$lib/components/log-viewer.svelte";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "$lib/components/ui/empty";
    import { Frame, FrameHeader, FramePanel } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Spinner } from "$lib/components/ui/spinner";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { classifyLog, type LogRow } from "$lib/resource-logs";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import Download from "@lucide/svelte/icons/download";
    import { createMutation } from "@tanstack/svelte-query";
    import { parseAsBoolean, parseAsString, useQueryStates } from "nuqs-svelte";
    import { untrack } from "svelte";

    useHeaderActions(cancelAction);

    type DeploymentEvent = Awaited<ReturnType<typeof client.cluster.streamDeployment>> extends AsyncIterable<infer T> ? T : never;

    let { deploymentId }: { deploymentId: string } = $props();

    let deployment = $state<DeploymentEvent["deployment"] | null>(null);

    let rows = $state.raw<LogRow[]>([]);

    let cancelAllowed = $state(false);

    let streamError = $state("");

    let reconnecting = $state(false);

    const view = useQueryStates({
        deploymentQuery: parseAsString.withDefault(""),
        deploymentDebug: parseAsBoolean.withDefault(false),
        deploymentWrap: parseAsBoolean.withDefault(true),
        deploymentFollowing: parseAsBoolean.withDefault(true),
    }, { shallow: true, scroll: false, history: "replace" });

    let copied = $state(false);

    let now = $state(Date.now());

    function toRow(line: DeploymentEvent["logs"][number]): LogRow {
        const level = line.metadata?.level ?? "info";
        const time = new Date(line.createdAt).getTime();

        return {
            id: line.id,
            key: String(line.id),
            time,
            timestamp: new Date(time).toISOString(),
            message: line.text,
            level: level === "error" ? "error" : classifyLog(line.text),
            label: level === "debug" ? "debug" : undefined,
            muted: level === "debug",
        };
    }

    const debugCount = $derived(rows.filter((row) => row.muted).length);

    const visibleLogs = $derived.by(() => {
        const needle = view.deploymentQuery.current.trim().toLowerCase();

        return rows.filter((row) => (view.deploymentDebug.current || !row.muted) && (!needle || row.message.toLowerCase().includes(needle)));
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
        let afterId = 0;
        let completed = false;
        let streamComplete = false;

        return subscribeToStream(
            (signal) => client.cluster.streamDeployment({ deploymentId: id, afterId }, { signal }),
            (event) => {
                streamComplete = event.complete;
                deployment = event.deployment;
                cancelAllowed = event.canCancel;
                streamError = "";
                reconnecting = false;

                // IDs are ordered by the server, including chunked replay and reconnects.
                const fresh = event.logs.filter((line) => line.id > afterId).map(toRow);

                if (fresh.length) {
                    rows = rows.concat(fresh);
                    afterId = fresh.at(-1)!.id;
                }

                if (!completed && ["ready", "failed", "cancelled"].includes(event.deployment.status)) {
                    completed = true;
                    void queryClient.invalidateQueries({ queryKey: orpc.cluster.key() });

                    if (event.deployment.resourceId) {
                        void queryClient.invalidateQueries({ queryKey: orpc.resources.key() });
                    }
                }
            },
            (error, retrying) => {
                streamError = error.message || "Unable to stream deployment logs.";
                reconnecting = retrying;
            },
            () => streamComplete,
        );
    });

    const status = $derived(deployment?.status ?? "queued");

    const isActive = $derived(status === "queued" || status === "running");

    // A queued deployment carrying an error is waiting for its next attempt.
    const retrying = $derived(status === "queued" && !!deployment?.error);

    const statusLabel = $derived(
        retrying
            ? "Retrying"
            : { queued: "Queued", running: "Running", ready: "Ready", failed: "Failed", cancelled: "Cancelled" }[status] ?? status,
    );

    const statusVariant = $derived<"success" | "warning" | "error" | "secondary">(
        status === "ready" ? "success" : status === "failed" ? "error" : isActive ? "warning" : "secondary",
    );

    const title = $derived(
        deployment?.name === "DeployResource"
            ? "Resource deployment"
            : deployment?.name === "InitializeCluster"
              ? "Cluster initialization"
              : (deployment?.name ?? "Deployment"),
    );

    const canCancel = $derived(cancelAllowed && isActive);

    const startedAt = $derived(deployment ? new Date(deployment.createdAt).getTime() : 0);

    const durationMs = $derived(
        deployment ? Math.max(0, (deployment.finishedAt ? new Date(deployment.finishedAt).getTime() : now) - startedAt) : null,
    );

    $effect(() => {
        if (!isActive) return;
        const timer = setInterval(() => (now = Date.now()), 1000);

        return () => clearInterval(timer);
    });

    function formatDuration(ms: number) {
        const seconds = Math.floor(ms / 1000);

        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);

        if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
        const hours = Math.floor(minutes / 60);

        return `${hours}h ${minutes % 60}m`;
    }

    // Elapsed since the deployment started, e.g. 00:07 or 01:02:07.
    function offset(value: Date | string) {
        const ms = Math.max(0, new Date(value).getTime() - startedAt);

        return new Date(ms).toISOString().slice(ms >= 3_600_000 ? 11 : 14, 19);
    }

    function plainText() {
        return visibleLogs
            .map((row) => `${row.timestamp} ${(row.label ?? (row.level === "error" ? "error" : "info")).toUpperCase().padEnd(5)} ${row.message}`)
            .join("\n");
    }

    async function copyLogs() {
        try {
            await navigator.clipboard.writeText(plainText());
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // Clipboard access denied; the log text stays selectable.
        }
    }

    function downloadLogs() {
        const url = URL.createObjectURL(new Blob([plainText() + "\n"], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `deployment-${deploymentId}.log`;
        link.click();
        URL.revokeObjectURL(url);
    }

    const cancelMutationState = createMutation(() =>
        orpc.cluster.cancelDeployment.mutationOptions({
            onSuccess: (_data, input) => {
                if (deploymentId === input.deploymentId) cancelAllowed = false;
                void queryClient.invalidateQueries({ queryKey: orpc.cluster.key() });
                void queryClient.invalidateQueries({ queryKey: orpc.resources.key() });
            },
        }),
    );

    function cancelDeployment() {
        if (!deploymentId || !canCancel || cancelMutationState.isPending) return;
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

<div class="flex h-[calc(100dvh-7rem)] min-h-120 w-full min-w-0 flex-col py-3 xl:h-auto xl:min-h-0 xl:flex-1">
    <Frame class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <FrameHeader class="shrink-0 gap-2 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
                <h1 class="text-sm font-medium">{title}</h1>
                {#if deployment}
                    <span role="status">
                        <Badge variant={statusVariant}>
                            {#if isActive && !retrying}<Spinner aria-hidden="true" />{/if}
                            {statusLabel}
                        </Badge>
                    </span>
                    <span class="text-xs text-muted-foreground tabular-nums">
                        <time datetime={new Date(deployment.createdAt).toISOString()}>{new Date(deployment.createdAt).toLocaleString()}</time>
                        {#if durationMs !== null}· {formatDuration(durationMs)}{/if}
                    </span>
                {/if}
                {#if streamError || cancelMutationState.error}
                    <span class="text-xs text-destructive-foreground">
                        {reconnecting ? "Reconnecting…" : streamError || cancelMutationState.error?.message || "Unable to cancel."}
                    </span>
                {/if}
            </div>
            <Input size="sm" type="search" aria-label="Filter logs" placeholder="Filter logs..." bind:value={() => view.deploymentQuery.current, (value) => (view.deploymentQuery.current = value)} />
        </FrameHeader>

        <FramePanel class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0">
            <LogViewer
                logs={visibleLogs}
                label="Deployment logs"
                timeWidth="8ch"
                formatTime={offset}
                highlight={view.deploymentQuery.current}
                start={deployment ? startedAt : undefined}
                end={deployment?.finishedAt ? new Date(deployment.finishedAt).getTime() : undefined}
                bind:wrap={() => view.deploymentWrap.current, (value) => (view.deploymentWrap.current = value)}
                bind:following={() => view.deploymentFollowing.current, (value) => (view.deploymentFollowing.current = value)}
            >
                {#snippet actions()}
                    {#if debugCount}
                        <Button variant={view.deploymentDebug.current ? "secondary" : "ghost"} size="xs" class="gap-1.5 text-xs" aria-pressed={view.deploymentDebug.current} onclick={() => (view.deploymentDebug.current = !view.deploymentDebug.current)}>
                            <span class="size-2 rounded-xs bg-muted-foreground/40" aria-hidden="true"></span>Debug<span class="font-mono tabular-nums">{debugCount}</span>
                        </Button>
                    {/if}
                    <Button variant="ghost" size="icon-xs" aria-label="Copy logs" title="Copy logs" disabled={!visibleLogs.length} onclick={copyLogs}>
                        {#if copied}<Check class="size-3.5" aria-hidden="true" />{:else}<Copy class="size-3.5" aria-hidden="true" />{/if}
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label="Download logs" title="Download logs" disabled={!visibleLogs.length} onclick={downloadLogs}><Download class="size-3.5" aria-hidden="true" /></Button>
                {/snippet}

                {#snippet empty()}
                    <Empty class="h-full">
                        <EmptyHeader>
                            <EmptyTitle>{rows.length ? "No matching lines" : !deployment || isActive ? "Waiting for output" : "No logs recorded"}</EmptyTitle>
                            <EmptyDescription>{rows.length ? "Clear the filter to see all lines." : !deployment || isActive ? "Deployment output appears here as it runs." : "This deployment finished without output."}</EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                {/snippet}
            </LogViewer>

            <div class="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                <span>Time since start</span>
                <span class="font-mono">{deploymentId}</span>
            </div>
        </FramePanel>
    </Frame>
</div>
