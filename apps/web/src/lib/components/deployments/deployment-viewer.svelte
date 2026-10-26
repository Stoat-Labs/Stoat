<script lang="ts">
    import { goto } from "$app/navigation";
    import { useHeaderActions } from "$lib/components/sidebar/header-actions";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import LogViewer from "$lib/components/shared/log-viewer.svelte";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
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
    import { DeploymentStream } from "$lib/deployments/deployment-stream.svelte";
    import { formatDurationMs } from "$lib/format";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { logsAsText } from "$lib/deployments/log-text";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import Download from "@lucide/svelte/icons/download";
    import { createMutation } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { tick } from "svelte";
    import DeploymentTimeline from "./deployment-timeline.svelte";

    useHeaderActions(cancelAction);

    let {
        deploymentId,
        backHref = "/deployments",
    }: {
        deploymentId: string;
        backHref?: string;
    } = $props();

    const view = useQueryStates(
        {
            deploymentQuery: parseAsString.withDefault(""),
            deploymentDebug: parseAsBoolean.withDefault(false),
            deploymentWrap: parseAsBoolean.withDefault(true),
            deploymentFollowing: parseAsBoolean.withDefault(true),
            dialog: parseAsStringLiteral(["spec", "delete"]),
        },
        { shallow: true, scroll: false, history: "replace" },
    );

    const stream = new DeploymentStream(
        () => deploymentId,
        () => {
            view.deploymentFollowing.current = true;
            cancelMutationState.reset();
        },
    );

    const deployment = $derived(stream.deployment);

    let copied = $state(false);

    const visibleLogs = $derived.by(() => {
        const needle = view.deploymentQuery.current
            .trim()
            .toLowerCase();

        return stream.rows.filter(
            (row) =>
                (view.deploymentDebug.current || !row.muted) &&
                (!needle ||
                    row.message.toLowerCase().includes(needle)),
        );
    });

    const resourceLabel = $derived(
        stream.origin.resourceName
            ? `${stream.origin.projectName ? `${stream.origin.projectName} / ` : ""}${stream.origin.resourceName}`
            : "",
    );

    const resourceHref = $derived(
        stream.origin.projectId && deployment?.resourceId
            ? `/projects/${stream.origin.projectId}/${deployment.resourceId}`
            : null,
    );

    const title = $derived(
        deployment?.name === "DeployResource"
            ? resourceLabel || "Resource deployment"
            : deployment?.name === "InitializeCluster"
              ? "Cluster initialization"
              : deployment?.name === "DeployCaddy"
                ? "Caddy deployment"
                : (deployment?.name ?? "Deployment"),
    );

    const raw = $derived(view.deploymentDebug.current);

    const visibleSteps = $derived.by(() => {
        const needle = view.deploymentQuery.current
            .trim()
            .toLowerCase();

        if (!needle) return stream.steps;

        return stream.steps.filter((step) =>
            [
                step.title,
                step.label,
                step.machine,
                step.detail,
                ...step.history,
                step.replaces?.title,
                ...(step.replaces?.history ?? []),
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
        void stream.status;

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

    async function copyLogs() {
        try {
            await navigator.clipboard.writeText(
                logsAsText(visibleLogs),
            );
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // Clipboard denial leaves the visible Copy button for manual retry.
        }
    }

    function downloadLogs() {
        const url = URL.createObjectURL(
            new Blob([logsAsText(visibleLogs) + "\n"], {
                type: "text/plain",
            }),
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
                    stream.cancelAllowed = false;
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

    const deleteMutationState = createMutation(() =>
        orpc.cluster.deleteDeployment.mutationOptions({
            onSuccess: async (_data, input) => {
                queryClient.removeQueries({
                    queryKey: orpc.cluster.getDeployment.queryKey({
                        input: { deploymentId: input.deploymentId },
                    }),
                });
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                });
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listDeployments.key(),
                });
                await goto(backHref);
            },
        }),
    );

    function closeDialog() {
        view.dialog.current = null;
    }

    function cancelDeployment() {
        if (
            !deploymentId ||
            !stream.canCancel ||
            cancelMutationState.isPending
        )
            return;
        cancelMutationState.mutate({ deploymentId });
    }
</script>

<svelte:head>
    <title>{title} / Stoat</title>
</svelte:head>

{#snippet cancelAction()}
    {#if deployment?.spec}
        <Button
            variant="outline"
            size="sm"
            onclick={() => (view.dialog.current = "spec")}
        >
            View spec
        </Button>
    {/if}
    {#if stream.canDelete}
        <Button
            variant="destructive-outline"
            size="sm"
            onclick={() => (view.dialog.current = "delete")}
        >
            Delete deployment
        </Button>
    {/if}
    {#if stream.canCancel}
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
            {stream.rows.length}
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
                {stream.rows.length
                    ? "No matching lines"
                    : !deployment || stream.isActive
                      ? "Waiting for output"
                      : "No logs recorded"}
            </EmptyTitle>
            <EmptyDescription>
                {stream.rows.length
                    ? "Clear the filter to see all lines."
                    : !deployment || stream.isActive
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
                <h1 class="text-sm font-medium">
                    {#if resourceHref}
                        <a
                            href={resourceHref}
                            class="hover:underline"
                        >
                            {title}
                        </a>
                    {:else}
                        {title}
                    {/if}
                </h1>
                {#if deployment}
                    <span role="status">
                        <Badge variant={stream.statusVariant}>
                            {#if stream.isActive && !stream.retrying}<Spinner
                                    aria-hidden="true"
                                />{/if}
                            {stream.statusLabel}
                        </Badge>
                    </span>
                {/if}
                {#if stream.durationMs !== null}<span
                        class="text-xs text-muted-foreground"
                    >
                        · {formatDurationMs(stream.durationMs)}
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
                    formatTime={stream.offset}
                    highlight={view.deploymentQuery.current}
                    start={deployment ? stream.startedAt : undefined}
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
                    {:else if !visibleSteps.length && (stream.isActive || !stream.rows.length || view.deploymentQuery.current)}
                        {@render emptyState()}
                    {:else if stream.durationMs !== null}
                        <DeploymentTimeline
                            steps={visibleSteps}
                            now={stream.now}
                            startedAt={stream.startedAt}
                            active={stream.isActive}
                            retrying={stream.retrying}
                            status={stream.status}
                            name={deployment.name}
                            error={deployment.error}
                            durationMs={stream.durationMs}
                            outcomeAt={new Date(
                                stream.retrying
                                    ? deployment.updatedAt
                                    : (deployment.finishedAt ??
                                          deployment.updatedAt),
                            ).getTime()}
                        />
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

<Dialog
    bind:open={
        () => view.dialog.current === "spec",
        (open) => {
            if (!open) closeDialog();
        }
    }
>
    <DialogContent class="max-w-4xl">
        <DialogHeader>
            <DialogTitle>Deployment spec</DialogTitle>
            <DialogDescription>
                Read-only Compose spec captured when this deployment
                was created.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="h-[55vh] min-h-48 overflow-hidden rounded-xl">
                <CodeEditor
                    value={deployment?.spec ?? ""}
                    label="Deployment spec"
                    fill
                    readOnly
                />
            </div>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={closeDialog}>
                Close
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={
        () => view.dialog.current === "delete",
        (open) => {
            if (!open) closeDialog();
        }
    }
    title="Delete deployment?"
    description="This permanently removes the deployment and its logs. Running services are not affected."
    confirmLabel="Delete deployment"
    pending={deleteMutationState.isPending}
    error={deleteMutationState.error?.message ?? ""}
    onconfirm={() => deleteMutationState.mutate({ deploymentId })}
/>
