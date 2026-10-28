<script lang="ts">
    import LogEmptyState from "$lib/components/projects/log-empty-state.svelte";
    import LogNotices from "$lib/components/projects/log-notices.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import { Kbd } from "$lib/components/ui/kbd";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import { logsAsText } from "$lib/deployments/log-text";
    import { logDateTime, toLocalDateInput } from "$lib/format";
    import {
        decorateLogs,
        LogStream,
    } from "$lib/resources/log-stream.svelte";
    import { selectedLogServices } from "$lib/resources/logs";
    import Download from "@lucide/svelte/icons/download";
    import ExternalLink from "@lucide/svelte/icons/external-link";
    import Search from "@lucide/svelte/icons/search";
    import X from "@lucide/svelte/icons/x";
    import {
        createInfiniteQuery,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";
    import { onMount } from "svelte";
    import CanvasLogTable from "./canvas-log-table.svelte";

    let {
        projectId,
        resourceId,
        serviceName,
        focused,
    }: {
        projectId: string;
        resourceId: string;
        /** The compose service selected on the canvas; every service when absent. */
        serviceName: string | undefined;
        /** Whether this panel is the top layer, so `/` may focus its filter. */
        focused: boolean;
    } = $props();

    // Compose prefixes names with `<projectId8>-<resourceId8>-`; the canvas shows them without it.
    const COMPOSE_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}-/u;

    const view = useQueryStates(
        {
            logQuery: parseAsString.withDefault(""),
            logWrap: parseAsBoolean.withDefault(false),
            logFollowing: parseAsBoolean.withDefault(true),
            // Set by the metrics tab's "Logs for this range": stored logs instead of the live tail.
            logStart: parseAsString,
            logEnd: parseAsString,
        },
        { shallow: true, scroll: false, history: "replace" },
    );

    const range = $derived(
        view.logStart.current && view.logEnd.current
            ? {
                  start: view.logStart.current,
                  end: view.logEnd.current,
              }
            : null,
    );

    let ready = $state(false);

    onMount(() => (ready = true));

    const servicesQuery = createQuery(() =>
        orpc.resources.listLogServices.queryOptions({
            input: { projectId, resourceId },
            enabled: ready,
            retry: false,
        }),
    );

    const services = $derived(servicesQuery.data?.services ?? []);

    // Log services carry the compose prefix, the canvas selection does not.
    const names = $derived(
        serviceName
            ? services
                  .filter(
                      (service) =>
                          service.name.replace(COMPOSE_PREFIX, "") ===
                          serviceName,
                  )
                  .map((service) => service.name)
            : null,
    );

    const selectedIds = $derived(
        selectedLogServices(services, names).map(
            (service) => service.id,
        ),
    );

    const stream = new LogStream(
        () => projectId,
        () => resourceId,
        () => names,
        () => selectedIds,
        () => false,
        () => ready && !range,
    );

    const history = createInfiniteQuery(() =>
        orpc.resources.searchLogs.infiniteOptions({
            input: (cursor: string | undefined) => ({
                projectId,
                resourceId,
                serviceIds: selectedIds,
                start: range?.start ?? "",
                end: range?.end ?? "",
                query: "",
                cursor,
            }),
            initialPageParam: undefined,
            getNextPageParam: (page) => page.nextCursor ?? undefined,
            enabled:
                ready && range !== null && selectedIds.length > 0,
            retry: false,
        }),
    );

    // Search pages come newest first; the table reads oldest to newest like the live tail.
    const historyLogs = $derived(
        decorateLogs(
            (history.data?.pages ?? []).flatMap((page) => page.logs),
        ).sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    );

    const logs = $derived(range ? historyLogs : stream.logs);

    const query = $derived(view.logQuery.current.toLowerCase());

    const visibleLogs = $derived(
        query
            ? logs.filter((log) =>
                  log.message.toLowerCase().includes(query),
              )
            : logs,
    );

    const loading = $derived(servicesQuery.isPending);

    let filter = $state<HTMLInputElement | null>(null);

    function focusFilter(event: KeyboardEvent) {
        const typing =
            event.target instanceof HTMLElement &&
            event.target.closest(
                "input, textarea, [contenteditable], [role=dialog], [role=alertdialog], [role=menu]",
            );

        if (event.key !== "/" || typing || !focused) return;
        event.preventDefault();
        filter?.focus();
    }

    function downloadLogs() {
        const url = URL.createObjectURL(
            new Blob([logsAsText(visibleLogs) + "\n"], {
                type: "text/plain",
            }),
        );

        const link = document.createElement("a");
        link.href = url;
        link.download = `logs-${resourceId}.log`;
        link.click();
        URL.revokeObjectURL(url);
    }

    const formatTime = (value: string) =>
        toLocalDateInput(new Date(value)).replace("T", " ");
</script>

<svelte:window onkeydown={focusFilter} />

<!-- Railway's log panel: a fixed filter row, then a table whose rows are the only thing that scrolls. -->
<div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 items-center gap-2 border-b px-6 py-3">
        <div class="relative min-w-0 flex-1">
            <Search
                class="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
            />
            <Input
                bind:ref={filter}
                type="search"
                class="[&_input]:pr-9 [&_input]:pl-9"
                aria-label="Filter logs"
                placeholder="Filter and search logs"
                bind:value={
                    () => view.logQuery.current,
                    (value) => (view.logQuery.current = value)
                }
            />
            <Kbd
                class="absolute top-1/2 right-2 z-10 -translate-y-1/2"
            >
                /
            </Kbd>
        </div>
        {#if range}
            {#if history.hasNextPage}
                <Button
                    variant="outline"
                    disabled={history.isFetchingNextPage}
                    onclick={() => history.fetchNextPage()}
                >
                    Load older
                </Button>
            {/if}
            <Button
                variant="outline"
                aria-label="Back to live logs"
                title="Back to live logs"
                onclick={() =>
                    view.set({ logStart: null, logEnd: null })}
            >
                {logDateTime(range.start)} to {logDateTime(range.end)}
                <X class="size-4" aria-hidden="true" />
            </Button>
        {/if}
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
        <Button
            variant="outline"
            size="icon"
            aria-label="Open logs page"
            title="Open the logs page to search stored logs"
            href="/projects/{projectId}/{resourceId}/logs"
        >
            <ExternalLink class="size-4" aria-hidden="true" />
        </Button>
    </div>

    {#if loading || (range && history.isPending && selectedIds.length)}
        <Skeleton
            loading
            loading-label="Loading logs"
            class="min-h-0 flex-1 p-6 font-mono text-xs leading-5"
            background-color="color-mix(in oklab, var(--foreground) 8%, transparent)"
            shimmer-color="color-mix(in oklab, var(--foreground) 6%, transparent)"
        >
            {#each [60, 85, 45, 70, 55, 80, 50, 65] as width, index (index)}
                <p class="py-0.5" style:width={`${width}%`}>
                    Loading logs
                </p>
            {/each}
        </Skeleton>
    {:else}
        <CanvasLogTable
            logs={visibleLogs}
            label="Resource logs"
            timeChars={19}
            {formatTime}
            highlight={view.logQuery.current}
            source={(log) =>
                log.container?.replace(COMPOSE_PREFIX, "") ??
                log.serviceName}
            bind:wrap={
                () => view.logWrap.current,
                (value) => (view.logWrap.current = value)
            }
            bind:following={
                () => view.logFollowing.current,
                (value) => (view.logFollowing.current = value)
            }
        >
            <LogNotices
                live={!range}
                streamError={stream.error}
                reconnecting={stream.reconnecting}
                failures={stream.failures.map((failure) => ({
                    ...failure,
                    name: services.find(
                        (service) => service.id === failure.id,
                    )?.name,
                }))}
                searchError={range
                    ? (history.error?.message ?? "")
                    : ""}
            />

            {#snippet empty()}
                <LogEmptyState
                    hasServices={selectedIds.length > 0}
                    mode={range ? "search" : "live"}
                    searched={history.isSuccess}
                    pending={history.isFetching}
                />
            {/snippet}
        </CanvasLogTable>
    {/if}
</div>
