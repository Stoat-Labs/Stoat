<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
    import LogViewer from "$lib/components/shared/log-viewer.svelte";
    import {
        logDateTime,
        parseDateInput,
        toLocalDateInput,
    } from "$lib/format";
    import { client, orpc } from "$lib/api/orpc";
    import { logBucketParser } from "$lib/params/query-params";
    import {
        decorateLogs,
        LogStream,
        type ViewLog,
    } from "$lib/resources/log-stream.svelte";
    import {
        rangeDurationMs,
        selectedLogServices,
    } from "$lib/resources/logs";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsArrayOf,
        parseAsBoolean,
        parseAsInteger,
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { onDestroy, onMount, untrack } from "svelte";
    import LogDetailRows from "./log-detail-rows.svelte";
    import LogEmptyState from "./log-empty-state.svelte";
    import LogLiveControls from "./log-live-controls.svelte";
    import LogNotices from "./log-notices.svelte";
    import LogPaneFooter from "./log-pane-footer.svelte";
    import LogSearchForm from "./log-search-form.svelte";
    import ServicePicker from "./service-picker.svelte";

    let {
        projectId,
        resourceId,
        active = true,
    }: {
        projectId: string;
        resourceId: string;
        active?: boolean;
    } = $props();

    // Compose prefixes names with `<projectId8>-<resourceId8>-`; it adds noise in the row label.
    const COMPOSE_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}-/u;

    const view = useQueryStates(
        {
            logServices: parseAsArrayOf(parseAsString),
            logServiceSearch: parseAsString.withDefault(""),
            logMode: parseAsStringLiteral([
                "live",
                "search",
            ]).withDefault("live"),
            logPaused: parseAsBoolean.withDefault(false),
            logText: parseAsString.withDefault(""),
            logLevel: parseAsStringLiteral([
                "error",
                "warning",
                "success",
                "other",
            ]),
            logBucket: logBucketParser,
            logWrap: parseAsBoolean.withDefault(false),
            logClean: parseAsBoolean.withDefault(true),
            logFollowing: parseAsBoolean.withDefault(true),
            logScroll: parseAsInteger
                .withDefault(0)
                .withOptions({ throttleMs: 200 }),
            logEntry: parseAsString,
            logRange: parseAsStringLiteral([
                "15m",
                "1h",
                "24h",
                "custom",
            ]).withDefault("15m"),
            logStart: parseAsString.withDefault(""),
            logEnd: parseAsString.withDefault(""),
        },
        { shallow: true, scroll: false, history: "replace" },
    );

    let ready = $state(false);

    const selection = $derived(
        view.logServices.current?.slice(0, 20) ?? null,
    );

    const paused = $derived(view.logPaused.current);

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
            enabled: ready && active,
        }),
    );

    const servicesQuery = createQuery(() =>
        orpc.resources.listLogServices.queryOptions({
            // Live connections populate discovery; keep the same cache for the service picker.
            input: { projectId, resourceId },
            enabled:
                ready &&
                active &&
                (selection?.length === 0 || view.logPaused.current),
            retry: false,
        }),
    );

    const services = $derived(servicesQuery.data?.services ?? []);

    // Shares the resource page's cached queries; machines without current containers fall back to their id.
    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: active && projectId.length > 0,
        }),
    );

    const clusterId = $derived(projectQuery.data?.clusterId ?? "");

    const containersQuery = createQuery(() =>
        orpc.resources.getContainers.queryOptions({
            input: { projectId, resourceId, clusterId },
            enabled:
                active &&
                clusterId.length > 0 &&
                Boolean(resourceQuery.data?.spec?.trim()),
        }),
    );

    const machineNames = $derived(
        new Map(
            (containersQuery.data ?? [])
                .filter((item) => item.machineName)
                .map((item) => [item.machineId, item.machineName]),
        ),
    );

    const loading = $derived(
        resourceQuery.isPending || servicesQuery.isPending,
    );

    const selectedServices = $derived(
        selectedLogServices(services, selection),
    );

    const selectedIds = $derived(
        selectedServices.map((service) => service.id),
    );

    const selectionKey = $derived(selectedIds.join(","));

    const scopeKey = $derived(
        `${projectId}/${resourceId}/${selectionKey}`,
    );

    const stream = new LogStream(
        () => projectId,
        () => resourceId,
        () => selection,
        () => selectedIds,
        () => view.logPaused.current,
        () => ready,
    );

    let viewport = $state<HTMLDivElement>();

    let historyLogs = $state.raw<ViewLog[]>([]);

    const start = $derived(parseDateInput(view.logStart.current));

    const end = $derived(parseDateInput(view.logEnd.current));

    let timezone = $state("Local time");

    let pending = $state(false);

    let searchError = $state("");

    let nextCursor = $state<string | null>(null);

    let searched = $state(false);

    let searchController: AbortController | undefined;

    let submitted = $state<{
        start: string;
        end: string;
        query: string;
        serviceIds: string[];
    } | null>(null);

    let restoreSearch = true;

    let previousStreamScope: string | null = null;

    let previousSearchScope: string | null = null;

    const logs = $derived(
        view.logMode.current === "live" ? stream.logs : historyLogs,
    );

    const liveFilter = $derived(
        view.logMode.current === "live"
            ? view.logText.current.toLowerCase()
            : "",
    );

    const matchedLogs = $derived(
        liveFilter
            ? logs.filter((log) =>
                  log.message.toLowerCase().includes(liveFilter),
              )
            : logs,
    );

    const searchSummary = $derived(
        submitted
            ? `${logDateTime(submitted.start)} to ${logDateTime(submitted.end)}${submitted.query ? ` / "${submitted.query}"` : ""}`
            : "Search within the configured retention period.",
    );

    function setDateInput(key: "logStart" | "logEnd", value: string) {
        const time = Date.parse(value);
        void view.set({
            [key]: Number.isFinite(time)
                ? new Date(time).toISOString()
                : "",
        });
    }

    function chooseRange(value: string) {
        view.logRange.current = value as typeof view.logRange.current;

        if (value === "custom") return;
        const now = new Date();
        const duration = rangeDurationMs(value);
        void view.set({
            logStart: new Date(
                now.getTime() - duration,
            ).toISOString(),
            logEnd: now.toISOString(),
        });
    }

    function selectService(name: string, checked: boolean) {
        const names =
            selection ??
            selectedServices.map((service) => service.name);

        view.logServices.current = checked
            ? [...names, name]
            : names.filter((selected) => selected !== name);
    }

    function toggleAllServices() {
        view.logServices.current =
            (selection?.length ?? selectedIds.length)
                ? []
                : services
                      .slice(0, 20)
                      .map((service) => service.name);
    }

    function resetSearch(clearBucket = true) {
        searchController?.abort();
        searchController = undefined;
        pending = false;
        historyLogs = [];
        nextCursor = null;
        searchError = "";
        searched = false;
        submitted = null;

        if (clearBucket) view.logBucket.current = null;
    }

    onMount(() => {
        ready = true;
        // Show the viewer's local timezone without persisting a browser-specific label.
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    });

    $effect.pre(() => {
        const scope = stream.scopeKey;

        if (
            previousStreamScope !== null &&
            previousStreamScope !== scope
        )
            view.logEntry.current = null;
        previousStreamScope = scope;
    });

    $effect.pre(() => {
        const scope = scopeKey;

        if (!servicesQuery.data || previousSearchScope === scope)
            return;

        const changed =
            previousSearchScope !== null &&
            previousSearchScope !== scope;

        previousSearchScope = scope;
        untrack(() => resetSearch(changed));
    });

    $effect(() => {
        if (
            ready &&
            active &&
            view.logMode.current === "search" &&
            view.logRange.current !== "custom" &&
            (!start || !end)
        )
            chooseRange(view.logRange.current);
    });

    $effect(() => {
        // Links from other tabs (e.g. metrics → "logs around this time") set the search range in the URL.
        if (!active) restoreSearch = true;
    });

    $effect(() => {
        if (
            !restoreSearch ||
            !ready ||
            !active ||
            view.logMode.current !== "search" ||
            !servicesQuery.data ||
            !selectedIds.length ||
            !start ||
            !end
        )
            return;
        restoreSearch = false;
        void search(false, undefined, true);
    });

    function togglePause() {
        if (!view.logPaused.current) stream.flush();
        view.logPaused.current = !view.logPaused.current;
    }

    function reconnect() {
        view.logPaused.current = false;
        stream.reconnect();
    }

    function changeMode(value: "live" | "search") {
        if (view.logMode.current === value) return;
        restoreSearch = false;
        resetSearch();
        view.logMode.current = value;
        view.logLevel.current = null;
        view.logFollowing.current = true;
        view.logScroll.current = 0;
        view.logEntry.current = null;
        view.logText.current = "";

        if (value === "search") chooseRange(view.logRange.current);
    }

    async function search(
        older = false,
        dates?: { start: string; end: string },
        preserveView = false,
    ) {
        if (
            view.logMode.current !== "search" ||
            pending ||
            !selectedIds.length ||
            (older && (!submitted || !nextCursor))
        )
            return;

        const range =
            older && submitted
                ? submitted
                : {
                      start: dates?.start ?? start,
                      end: dates?.end ?? end,
                      query: view.logText.current,
                      serviceIds: [...selectedIds],
                  };

        const from = Date.parse(range.start);
        const until = Date.parse(range.end);

        if (
            !Number.isFinite(from) ||
            !Number.isFinite(until) ||
            until <= from ||
            until - from > 366 * 86_400_000
        ) {
            searchError =
                "Choose valid dates with an end after the start, within a 366-day range.";

            return;
        }

        searchController?.abort();
        const controller = new AbortController();
        searchController = controller;
        const searchScope = scopeKey;

        const isCurrent = () =>
            searchController === controller &&
            !controller.signal.aborted &&
            view.logMode.current === "search" &&
            scopeKey === searchScope;

        pending = true;
        searchError = "";

        try {
            const normalized = {
                ...range,
                start: new Date(from).toISOString(),
                end: new Date(until).toISOString(),
            };

            if (!older) {
                if (dates)
                    void view.set({
                        logStart: normalized.start,
                        logEnd: normalized.end,
                    });

                if (!preserveView) {
                    view.logBucket.current = null;
                    view.logEntry.current = null;
                    view.logScroll.current = 0;
                }

                submitted = normalized;
                historyLogs = [];
                nextCursor = null;
                searched = false;
            }

            const result = await client.resources.searchLogs(
                {
                    projectId,
                    resourceId,
                    ...normalized,
                    cursor: older
                        ? (nextCursor ?? undefined)
                        : undefined,
                },
                { signal: controller.signal },
            );

            if (!isCurrent()) return;
            historyLogs = [
                ...historyLogs,
                ...decorateLogs(result.logs),
            ];
            nextCursor = result.nextCursor;
            searched = true;

            if (!older && !preserveView && viewport)
                viewport.scrollTop = 0;
        } catch (error) {
            if (isCurrent())
                searchError =
                    error instanceof Error
                        ? error.message
                        : "Unable to search logs.";
        } finally {
            if (searchController === controller) pending = false;
        }
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault();

        if (view.logRange.current !== "custom") {
            const duration = rangeDurationMs(view.logRange.current);
            const now = new Date();
            void search(false, {
                start: toLocalDateInput(
                    new Date(now.getTime() - duration),
                ),
                end: toLocalDateInput(now),
            });

            return;
        }

        void search();
    }

    onDestroy(() => searchController?.abort());
</script>

<svelte:head>
    {#if active}<title>
            Logs / {resourceQuery.data?.name ?? "Resource"} / Stoat
        </title>{/if}
</svelte:head>

{#if active}
    <div
        class="flex h-[calc(100dvh-7rem)] min-h-160 min-w-0 w-full flex-col gap-3 pt-3 xl:h-auto xl:min-h-0 xl:flex-1"
    >
        {#if resourceQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    {resourceQuery.error.message}
                </AlertDescription>
            </Alert>
            <Button
                variant="outline"
                size="sm"
                class="self-start"
                onclick={() => resourceQuery.refetch()}
            >
                Try again
            </Button>
        {:else if servicesQuery.isError || (stream.error && !servicesQuery.data)}
            <Alert variant="error">
                <AlertDescription>
                    {servicesQuery.error?.message ?? stream.error}
                </AlertDescription>
            </Alert>
            <Button
                variant="outline"
                size="sm"
                class="self-start"
                onclick={reconnect}
            >
                Try again
            </Button>
        {:else if !loading && !services.length}
            <Empty class="flex-1 rounded-2xl border border-dashed">
                <EmptyHeader>
                    <EmptyTitle>
                        No deployed services
                    </EmptyTitle><EmptyDescription>
                        Deploy this resource to view logs from its
                        current services.
                    </EmptyDescription>
                </EmptyHeader>
                <Button
                    variant="outline"
                    size="sm"
                    href="/projects/{projectId}/{resourceId}"
                >
                    Open resource
                </Button>
            </Empty>
        {:else}
            <Skeleton
                {loading}
                label="Loading logs"
                fill
                class="min-w-0"
                style="--skullet-base: color-mix(in oklab, var(--foreground) 8%, transparent); --skullet-highlight: color-mix(in oklab, var(--foreground) 6%, transparent)"
            >
                <Frame
                    inert={loading}
                    class="min-h-0 min-w-0 flex-1 overflow-hidden {view
                        .logMode.current === 'search' &&
                    view.logRange.current === 'custom'
                        ? 'max-xl:min-h-192'
                        : ''}"
                >
                    <FrameHeader class="shrink-0 gap-3 px-3 py-2">
                        <div
                            class="flex flex-wrap items-center gap-2"
                        >
                            <div
                                class="flex items-center gap-1 rounded-lg bg-background/60 p-0.5"
                                role="group"
                                aria-label="Log source"
                            >
                                <Button
                                    variant={view.logMode.current ===
                                    "live"
                                        ? "outline"
                                        : "ghost"}
                                    size="sm"
                                    aria-pressed={view.logMode
                                        .current === "live"}
                                    onclick={() => changeMode("live")}
                                >
                                    Live
                                </Button>
                                <Button
                                    variant={view.logMode.current ===
                                    "search"
                                        ? "outline"
                                        : "ghost"}
                                    size="sm"
                                    aria-pressed={view.logMode
                                        .current === "search"}
                                    onclick={() =>
                                        changeMode("search")}
                                >
                                    Search
                                </Button>
                            </div>
                            <ServicePicker
                                {services}
                                {selectedIds}
                                selectedCount={selection?.length ??
                                    selectedIds.length}
                                bind:search={
                                    () =>
                                        view.logServiceSearch.current,
                                    (value) =>
                                        (view.logServiceSearch.current =
                                            value)
                                }
                                onSelect={selectService}
                                onToggleAll={toggleAllServices}
                            />
                            <span
                                skullet-ignore
                                class="min-w-0 flex-1 whitespace-nowrap text-xs text-muted-foreground sm:min-w-16"
                            ></span>
                            {#if view.logMode.current === "live" && (loading || selectedIds.length)}
                                <LogLiveControls
                                    status={stream.status}
                                    warn={stream.failures.length >
                                        0 || !!stream.error}
                                    paused={view.logPaused.current}
                                    reconnecting={servicesQuery.isFetching}
                                    ontogglepause={togglePause}
                                    onreconnect={reconnect}
                                />
                            {/if}
                        </div>
                        {#if view.logMode.current === "live"}
                            <Input
                                size="sm"
                                type="search"
                                aria-label="Filter loaded logs"
                                placeholder="Filter loaded logs..."
                                bind:value={
                                    () => view.logText.current,
                                    (value) =>
                                        (view.logText.current = value)
                                }
                            />
                        {:else if servicesQuery.data?.historyAvailable}
                            <LogSearchForm
                                bind:query={
                                    () => view.logText.current,
                                    (value) =>
                                        (view.logText.current = value)
                                }
                                range={view.logRange.current}
                                bind:start={
                                    () => start,
                                    (value) =>
                                        setDateInput(
                                            "logStart",
                                            value,
                                        )
                                }
                                bind:end={
                                    () => end,
                                    (value) =>
                                        setDateInput("logEnd", value)
                                }
                                {pending}
                                canSearch={selectedIds.length > 0}
                                retentionDays={servicesQuery.data
                                    ?.retentionDays ?? null}
                                {timezone}
                                onrange={chooseRange}
                                onsubmit={submitSearch}
                            />
                        {/if}
                    </FrameHeader>

                    {#if view.logMode.current === "search" && !servicesQuery.data?.historyAvailable}
                        <FramePanel
                            class="flex min-h-0 flex-1 items-center justify-center"
                        >
                            <Empty>
                                <EmptyHeader>
                                    <EmptyTitle>
                                        Historical logs unavailable
                                    </EmptyTitle><EmptyDescription>
                                        Initialize cluster monitoring
                                        to store and search logs in
                                        GreptimeDB. Live logs are
                                        still available.
                                    </EmptyDescription>
                                </EmptyHeader><Button
                                    variant="outline"
                                    size="sm"
                                    onclick={() => changeMode("live")}
                                >
                                    View live logs
                                </Button>
                            </Empty>
                        </FramePanel>
                    {:else}
                        <FramePanel
                            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0"
                        >
                            <LogViewer
                                logs={matchedLogs}
                                {loading}
                                {pending}
                                follow={view.logMode.current ===
                                    "live"}
                                start={view.logMode.current ===
                                    "search" && submitted
                                    ? Date.parse(submitted.start)
                                    : undefined}
                                end={view.logMode.current ===
                                    "search" && submitted
                                    ? Date.parse(submitted.end)
                                    : undefined}
                                highlight={view.logMode.current ===
                                "live"
                                    ? view.logText.current
                                    : ""}
                                note={view.logMode.current ===
                                    "search" && searched
                                    ? "Newest first"
                                    : ""}
                                source={(log) =>
                                    log.container?.replace(
                                        COMPOSE_PREFIX,
                                        "...",
                                    ) ?? log.serviceName}
                                bind:viewport
                                bind:level={
                                    () => view.logLevel.current,
                                    (value) =>
                                        (view.logLevel.current =
                                            value)
                                }
                                bind:bucket={
                                    () => view.logBucket.current,
                                    (value) =>
                                        (view.logBucket.current =
                                            value)
                                }
                                bind:wrap={
                                    () => view.logWrap.current,
                                    (value) =>
                                        (view.logWrap.current = value)
                                }
                                bind:clean={
                                    () => view.logClean.current,
                                    (value) =>
                                        (view.logClean.current =
                                            value)
                                }
                                bind:following={
                                    () => view.logFollowing.current,
                                    (value) =>
                                        (view.logFollowing.current =
                                            value)
                                }
                                bind:scroll={
                                    () => view.logScroll.current,
                                    (value) =>
                                        (view.logScroll.current =
                                            value)
                                }
                                bind:entry={
                                    () => view.logEntry.current,
                                    (value) =>
                                        (view.logEntry.current =
                                            value)
                                }
                            >
                                <LogNotices
                                    live={view.logMode.current ===
                                        "live"}
                                    streamError={stream.error}
                                    reconnecting={stream.reconnecting}
                                    failures={stream.failures.map(
                                        (failure) => ({
                                            ...failure,
                                            name: services.find(
                                                (service) =>
                                                    service.id ===
                                                    failure.id,
                                            )?.name,
                                        }),
                                    )}
                                    {searchError}
                                />

                                {#snippet details(log)}
                                    <LogDetailRows
                                        {log}
                                        machineName={log.machine
                                            ? (machineNames.get(
                                                  log.machine,
                                              ) ?? log.machine)
                                            : null}
                                    />
                                {/snippet}

                                {#snippet empty()}
                                    <LogEmptyState
                                        hasServices={selectedIds.length >
                                            0}
                                        mode={view.logMode.current}
                                        {searched}
                                        {pending}
                                    />
                                {/snippet}
                            </LogViewer>

                            <LogPaneFooter
                                live={view.logMode.current === "live"}
                                {timezone}
                                {searchSummary}
                                hasMore={!!nextCursor}
                                capped={historyLogs.length >= 2000}
                                {pending}
                                onloadolder={() => search(true)}
                            />
                        </FramePanel>
                    {/if}
                </Frame>
            </Skeleton>
        {/if}
    </div>
{/if}
