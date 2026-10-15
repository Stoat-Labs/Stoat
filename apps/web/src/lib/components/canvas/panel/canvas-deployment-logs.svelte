<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import DeploymentTimeline from "$lib/components/deployments/deployment-timeline.svelte";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
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
    import { Input } from "$lib/components/ui/input";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Spinner } from "$lib/components/ui/spinner";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { DeploymentStream } from "$lib/deployments/deployment-stream.svelte";
    import { logsAsText } from "$lib/deployments/log-text";
    import Box from "@lucide/svelte/icons/box";
    import Check from "@lucide/svelte/icons/check";
    import Copy from "@lucide/svelte/icons/copy";
    import Download from "@lucide/svelte/icons/download";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import Search from "@lucide/svelte/icons/search";
    import X from "@lucide/svelte/icons/x";
    import { createMutation } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { tick } from "svelte";
    import CanvasLogTable from "./canvas-log-table.svelte";

    let {
        deploymentId,
        name,
        icon,
        onclose,
    }: {
        deploymentId: string;
        name: string;
        icon: string | null;
        onclose: () => void;
    } = $props();

    // Details is the condensed step timeline; Logs is every raw line, like Railway's Deploy Logs.
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
            cancelMutation.reset();
        },
    );

    const deployment = $derived(stream.deployment);

    const raw = $derived(view.deploymentDebug.current);

    const query = $derived(
        view.deploymentQuery.current.trim().toLowerCase(),
    );

    const visibleLogs = $derived(
        stream.rows.filter(
            (row) =>
                !row.muted &&
                (!query || row.message.toLowerCase().includes(query)),
        ),
    );

    const visibleSteps = $derived(
        query
            ? stream.steps.filter((step) =>
                  [
                      step.title,
                      step.label,
                      step.machine,
                      step.detail,
                      ...step.history,
                      ...step.ops.flatMap((op) => [
                          op.title,
                          op.detail,
                      ]),
                  ]
                      .join(" ")
                      .toLowerCase()
                      .includes(query),
              )
            : stream.steps,
    );

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

    let copied = $state(false);

    async function copyLogs() {
        try {
            await navigator.clipboard.writeText(
                logsAsText(visibleLogs),
            );
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // Clipboard denial leaves the Copy button for a manual retry.
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

    const cancelMutation = createMutation(() =>
        orpc.cluster.cancelDeployment.mutationOptions({
            onSuccess: async () => {
                stream.cancelAllowed = false;
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                });
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });
            },
        }),
    );

    const deleteMutation = createMutation(() =>
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
                closeDialog();
                onclose();
            },
        }),
    );

    function closeDialog() {
        view.dialog.current = null;
    }
</script>

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

<!-- Railway's deployment panel: header, tabs, filter bar, then a log table that runs edge to edge. -->
<div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center gap-3 px-12 pt-12 pb-6">
        {#if icon}
            <img
                src={icon}
                alt=""
                aria-hidden="true"
                class="size-8 shrink-0 object-contain"
            />
        {:else}
            <Box
                class="size-8 shrink-0"
                strokeWidth={1.5}
                aria-hidden="true"
            />
        {/if}
        <h2 class="min-w-0 truncate text-2xl font-semibold">
            {name}
            <span
                class="font-mono text-lg font-normal text-muted-foreground"
            >
                / {deploymentId.slice(0, 8)}
            </span>
        </h2>
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
        <span class="ml-auto"></span>
        {#if deployment}
            <time
                class="hidden shrink-0 text-sm text-muted-foreground sm:inline"
                datetime={new Date(
                    deployment.createdAt,
                ).toISOString()}
            >
                {new Date(deployment.createdAt).toLocaleString()}
            </time>
        {/if}
        {#if deployment?.spec || stream.canDelete || stream.canCancel}
            <Menu>
                <MenuTrigger
                    class="flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
                    aria-label="Deployment actions"
                >
                    <EllipsisVertical
                        class="size-4"
                        aria-hidden="true"
                    />
                </MenuTrigger>
                <MenuPopup align="end" class="min-w-48">
                    {#if deployment?.spec}
                        <MenuItem
                            onclick={() =>
                                (view.dialog.current = "spec")}
                        >
                            View spec
                        </MenuItem>
                    {/if}
                    {#if stream.canCancel}
                        <MenuItem
                            disabled={cancelMutation.isPending}
                            onclick={() =>
                                cancelMutation.mutate({
                                    deploymentId,
                                })}
                        >
                            Cancel deployment
                        </MenuItem>
                    {/if}
                    {#if stream.canDelete}
                        <MenuItem
                            variant="destructive"
                            onclick={() =>
                                (view.dialog.current = "delete")}
                        >
                            Delete deployment
                        </MenuItem>
                    {/if}
                </MenuPopup>
            </Menu>
        {/if}
        <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close deployment"
            onclick={onclose}
        >
            <X class="size-4" aria-hidden="true" />
        </Button>
    </header>

    {#if cancelMutation.error}
        <p class="px-12 pb-3 text-sm text-destructive-foreground">
            {cancelMutation.error.message}
        </p>
    {/if}

    <div
        class="flex shrink-0 gap-8 border-b border-border px-12"
        role="tablist"
        aria-label="Deployment sections"
    >
        {#each [{ label: "Details", raw: false }, { label: "Logs", raw: true }] as tab (tab.label)}
            <button
                type="button"
                role="tab"
                aria-selected={raw === tab.raw}
                class={[
                    "relative shrink-0 pb-3 text-base transition-colors",
                    raw === tab.raw
                        ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground"
                        : "text-muted-foreground hover:text-foreground",
                ]}
                onclick={() =>
                    (view.deploymentDebug.current = tab.raw)}
            >
                {tab.label}
            </button>
        {/each}
    </div>

    <div class="flex shrink-0 items-center gap-2 border-b px-6 py-3">
        <div class="relative min-w-0 flex-1">
            <Search
                class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
            />
            <Input
                type="search"
                class="[&_input]:pl-9"
                aria-label="Filter logs"
                placeholder="Filter and search logs"
                bind:value={
                    () => view.deploymentQuery.current,
                    (value) => (view.deploymentQuery.current = value)
                }
            />
        </div>
        <Button
            variant="outline"
            size="icon"
            aria-label="Copy logs"
            title="Copy logs"
            disabled={!visibleLogs.length}
            onclick={copyLogs}
        >
            {#if copied}<Check
                    class="size-4"
                    aria-hidden="true"
                />{:else}<Copy
                    class="size-4"
                    aria-hidden="true"
                />{/if}
        </Button>
        <Button
            variant="outline"
            size="icon"
            aria-label="Download logs"
            title="Download logs"
            disabled={!visibleLogs.length}
            onclick={downloadLogs}
        >
            <Download class="size-4" aria-hidden="true" />
        </Button>
    </div>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        {#if raw}
            <CanvasLogTable
                logs={visibleLogs}
                label="Deployment logs"
                timeWidth="8ch"
                formatTime={stream.offset}
                highlight={view.deploymentQuery.current}
                bind:wrap={
                    () => view.deploymentWrap.current,
                    (value) => (view.deploymentWrap.current = value)
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
                class="min-h-0 flex-1 overflow-auto p-6 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                {:else if !visibleSteps.length && (stream.isActive || !stream.rows.length || query)}
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
    </div>
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
    pending={deleteMutation.isPending}
    error={deleteMutation.error?.message ?? ""}
    onconfirm={() => deleteMutation.mutate({ deploymentId })}
/>
