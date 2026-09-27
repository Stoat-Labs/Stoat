<script lang="ts">
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button, buttonVariants } from "$lib/components/ui/button";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "$lib/components/ui/empty";
    import { Frame, FrameHeader, FramePanel } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "$lib/components/ui/popover";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import LogViewer from "$lib/components/log-viewer.svelte";
    import { subscribeToStream } from "$lib/deployment-stream";
    import { client, orpc, queryClient } from "$lib/orpc";
    import { classifyLog, logEntryKey, selectedLogServices, type DisplayLog, type LogBucket } from "$lib/resource-logs";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Pause from "@lucide/svelte/icons/pause";
    import Play from "@lucide/svelte/icons/play";
    import RefreshCw from "@lucide/svelte/icons/refresh-cw";
    import Search from "@lucide/svelte/icons/search";
    import type { ResourceLog } from "@stoat/api/routers/resources/logs";
    import { createQuery } from "@tanstack/svelte-query";
    import { createParser, parseAsArrayOf, parseAsBoolean, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs-svelte";
    import { onDestroy, onMount, untrack } from "svelte";

    let { projectId, resourceId, active = true }: { projectId: string; resourceId: string; active?: boolean } = $props();

    type ViewLog = DisplayLog & { key: string };

    const bucketParser = createParser<LogBucket>({
        parse(value) {
            const parts = value.split(":").map(Number);

            if (parts.length !== 3) return null;
            const [index, domainStart, domainEnd] = parts;

            if (!Number.isInteger(index) || index! < 0 || index! > 23 || !Number.isSafeInteger(domainStart) || !Number.isSafeInteger(domainEnd) || domainEnd! <= domainStart!) return null;

            return { index: index!, domainStart: domainStart!, domainEnd: domainEnd! };
        },
        serialize: ({ index, domainStart, domainEnd }) => `${index}:${domainStart}:${domainEnd}`,
    });

    const view = useQueryStates({
        logServices: parseAsArrayOf(parseAsString),
        logServiceSearch: parseAsString.withDefault(""),
        logMode: parseAsStringLiteral(["live", "search"]).withDefault("live"),
        logPaused: parseAsBoolean.withDefault(false),
        logText: parseAsString.withDefault(""),
        logLevel: parseAsStringLiteral(["error", "warning", "success", "other"]),
        logBucket: bucketParser,
        logWrap: parseAsBoolean.withDefault(false),
        logClean: parseAsBoolean.withDefault(true),
        logFollowing: parseAsBoolean.withDefault(true),
        logScroll: parseAsInteger.withDefault(0).withOptions({ throttleMs: 200 }),
        logEntry: parseAsString,
        logRange: parseAsStringLiteral(["15m", "1h", "24h", "custom"]).withDefault("15m"),
        logStart: parseAsString.withDefault(""),
        logEnd: parseAsString.withDefault(""),
    }, { shallow: true, scroll: false, history: "replace" });

    let ready = $state(false);

    const selection = $derived(view.logServices.current?.slice(0, 20) ?? null);

    const paused = $derived(view.logPaused.current);

    const resourceQuery = createQuery(() => orpc.resources.getResource.queryOptions({
        input: { projectId, resourceId }, enabled: ready && active,
    }));

    const servicesQuery = createQuery(() => orpc.resources.listLogServices.queryOptions({
        // Live connections populate discovery; keep the same cache for the service picker.
        input: { projectId, resourceId }, enabled: ready && active && (selection?.length === 0 || view.logPaused.current), retry: false,
    }));

    const services = $derived(servicesQuery.data?.services ?? []);

    // Shares the resource page's cached queries; machines without current containers fall back to their id.
    const projectQuery = createQuery(() => orpc.projects.getProject.queryOptions({ input: { projectId }, enabled: active && projectId.length > 0 }));

    const clusterId = $derived(projectQuery.data?.clusterId ?? "");

    const containersQuery = createQuery(() => orpc.resources.getContainers.queryOptions({
        input: { projectId, resourceId, clusterId },
        enabled: active && clusterId.length > 0 && Boolean(resourceQuery.data?.spec?.trim()),
    }));

    const machineNames = $derived(new Map((containersQuery.data ?? []).filter((item) => item.machineName).map((item) => [item.machineId, item.machineName])));

    const loading = $derived(resourceQuery.isPending || servicesQuery.isPending);

    const selectedServices = $derived(selectedLogServices(services, selection));

    const selectedIds = $derived(selectedServices.map((service) => service.id));

    const selectionKey = $derived(selectedIds.join(","));

    const scopeKey = $derived(`${projectId}/${resourceId}/${selectionKey}`);

    const streamScopeKey = $derived(`${projectId}/${resourceId}/${selection === null ? "all" : selection.join(",")}`);

    const visibleServices = $derived(services.filter((service) => service.name.toLowerCase().includes(view.logServiceSearch.current.toLowerCase())));

    let attempt = $state(0);

    let viewport = $state<HTMLDivElement>();

    let liveLogs = $state.raw<ViewLog[]>([]);

    let historyLogs = $state.raw<ViewLog[]>([]);

    let discarded = $state(0);

    let streamError = $state("");

    let reconnecting = $state(false);

    let serviceStates = $state<{ id: string; state: "connecting" | "connected" | "reconnecting" | "error"; message?: string }[]>([]);

    let nextId = 0;

    const start = $derived(dateInput(view.logStart.current));

    const end = $derived(dateInput(view.logEnd.current));

    let timezone = $state("Local time");

    let pending = $state(false);

    let searchError = $state("");

    let nextCursor = $state<string | null>(null);

    let searched = $state(false);

    let searchController: AbortController | undefined;

    let flushLive = () => {};

    let submitted = $state<{ start: string; end: string; query: string; serviceIds: string[] } | null>(null);

    let restoreSearch = true;

    let previousStreamScope: string | null = null;

    let previousSearchScope: string | null = null;

    const logs = $derived(view.logMode.current === "live" ? liveLogs : historyLogs);

    const liveFilter = $derived(view.logMode.current === "live" ? view.logText.current.toLowerCase() : "");

    const matchedLogs = $derived(liveFilter ? logs.filter((log) => log.message.toLowerCase().includes(liveFilter)) : logs);

    const connected = $derived(serviceStates.filter((service) => service.state === "connected").length);

    const failures = $derived(serviceStates.filter((service) => service.state === "error" || service.state === "reconnecting"));

    const status = $derived(view.logPaused.current ? "Paused" : reconnecting ? "Reconnecting" : streamError ? "Disconnected" : failures.length ? connected > 0 ? "Partial stream" : failures.some((service) => service.state === "reconnecting") ? "Reconnecting" : "Disconnected" : connected === selectedIds.length && connected > 0 ? "Live" : "Connecting");

    const searchSummary = $derived(submitted ? `${time(submitted.start, true)} to ${time(submitted.end, true)}${submitted.query ? ` / "${submitted.query}"` : ""}` : "Search within the configured retention period.");

    function localDate(value: Date) {
        return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    }

    function dateInput(value: string) {
        const time = Date.parse(value);

        return Number.isFinite(time) ? localDate(new Date(time)) : "";
    }

    function setDateInput(key: "logStart" | "logEnd", value: string) {
        const time = Date.parse(value);
        void view.set({ [key]: Number.isFinite(time) ? new Date(time).toISOString() : "" });
    }

    function chooseRange(value: string) {

        view.logRange.current = value as typeof view.logRange.current;

        if (value === "custom") return;
        const now = new Date();
        let duration = 900_000;

        if (value === "1h") duration = 3_600_000;

        if (value === "24h") duration = 86_400_000;
        void view.set({ logStart: new Date(now.getTime() - duration).toISOString(), logEnd: now.toISOString() });
    }

    function selectService(name: string, checked: boolean) {
        const names = selection ?? selectedServices.map((service) => service.name);
        view.logServices.current = checked ? [...names, name] : names.filter((selected) => selected !== name);
    }

    function decorate(entries: ResourceLog[]) {
        return entries.map((entry) => ({ ...entry, id: nextId++, key: logEntryKey(entry), time: Date.parse(entry.timestamp), level: classifyLog(entry.message) }));
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
        const scope = streamScopeKey;

        if (previousStreamScope !== null && previousStreamScope !== scope) view.logEntry.current = null;
        previousStreamScope = scope;
        liveLogs = [];
        discarded = 0;
        streamError = "";
        reconnecting = false;
        serviceStates = [];
    });

    $effect.pre(() => {
        const scope = scopeKey;
        const changed = previousSearchScope !== null && previousSearchScope !== scope;

        if (servicesQuery.data) previousSearchScope = scope;
        untrack(() => resetSearch(changed));
    });

    $effect(() => {
        if (ready && active && view.logMode.current === "search" && view.logRange.current !== "custom" && (!start || !end)) chooseRange(view.logRange.current);
    });

    $effect(() => {
        if (!restoreSearch || !ready || !active || view.logMode.current !== "search" || !servicesQuery.data || !selectedIds.length || !start || !end) return;
        restoreSearch = false;
        void search(false, undefined, true);
    });

    $effect(() => {
        // Track selection intent, not IDs that can change during a deployment.
        // Key on the string: nuqs re-derives every key (e.g. logScroll), which would otherwise reopen the stream.
        void streamScopeKey;
        const names = untrack(() => selection === null ? null : [...selection]);
        const scope = { projectId, resourceId };
        const servicesKey = orpc.resources.listLogServices.queryKey({ input: scope });
        void attempt;

        if (!ready || paused || names?.length === 0) return;

        reconnecting = false;
        let incoming: ResourceLog[] = [];
        let overflow = false;
        let incomingBytes = 0;
        let replaceTail = true;
        let stop = () => {};

        const flush = () => {
            if (!incoming.length) return;
            const combined = [...(replaceTail ? [] : liveLogs), ...decorate(incoming)].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

            if (replaceTail) discarded = 0;
            replaceTail = false;
            incoming = [];
            incomingBytes = 0;
            let bytes = combined.reduce((sum, log) => sum + log.message.length * 2 + 512, 0);
            let remove = 0;

            while (combined.length - remove > 1000000 || bytes > 100 * 1024 * 1024) {
                bytes -= combined[remove]!.message.length * 2 + 512;
                remove++;
            }

            discarded += remove;
            liveLogs = combined.slice(remove);
        };

        const timer = setInterval(flush, 100);
        flushLive = flush;
        stop = untrack(() => subscribeToStream(
            (signal) => {
                // Uncloud reconnects replay the recent tail, not an exactly-once cursor.
                // Keep the previous buffer visible until the first replay batch arrives.
                replaceTail = true;
                incoming = [];
                incomingBytes = 0;
                streamError = "";
                serviceStates = selectedIds.map((id) => ({ id, state: "connecting" }));

                // Resolve names and open current IDs together on the server, avoiding a refetch/open race.
                return client.resources.streamLogs({ ...scope, serviceNames: names ?? undefined }, { signal });
            },
            (event) => {
                reconnecting = false;

                if (event.type === "services") {
                    if (event.services.length === 0) {
                        liveLogs = [];
                        discarded = 0;
                    }

                    queryClient.setQueryData(servicesKey, {
                        services: event.services,
                        historyAvailable: event.historyAvailable,
                        retentionDays: event.retentionDays,
                    });
                    serviceStates = selectedLogServices(event.services, names).map((service) => ({ id: service.id, state: "connecting" }));
                } else if (event.type === "reset") {
                    liveLogs = liveLogs.filter((log) => log.serviceId !== event.serviceId);
                    incoming = incoming.filter((log) => log.serviceId !== event.serviceId);
                    incomingBytes = incoming.reduce((sum, log) => sum + log.message.length * 2 + 512, 0);

                    const replacement = event.replacement;

                    if (replacement) {
                        queryClient.setQueryData(servicesKey, (current) => current ? {
                            ...current,
                            services: current.services.map((service) => service.id === event.serviceId ? replacement : service),
                        } : current);
                        serviceStates = serviceStates.map((service) => service.id === event.serviceId ? { id: replacement.id, state: "connecting" } : service);
                    }
                } else if (event.type === "status") {
                    serviceStates = serviceStates.map((service) => service.id === event.serviceId ? { id: service.id, state: event.state, message: event.message } : service);
                } else {
                    for (const log of event.logs) {
                        incoming.push(log);
                        incomingBytes += log.message.length * 2 + 512;
                    }

                    if (incoming.length > 2000 || incomingBytes > 4 * 1024 * 1024) {
                        flush();
                        overflow = true;
                        streamError = "Log volume exceeded the live buffer. Reconnect or search a time range.";
                        clearInterval(timer);
                        stop();
                    }
                }
            },
            (error, retrying) => {
                flush();
                streamError = error.message;
                reconnecting = retrying;

                if (!retrying) clearInterval(timer);
            },
            () => {
                const ended = overflow || (serviceStates.length > 0 && serviceStates.every((service) => service.state === "error"));

                if (ended) {
                    flush();
                    clearInterval(timer);
                }

                return ended;
            },
            ["BAD_GATEWAY"],
        ));

        return () => {
            clearInterval(timer);
            stop();
            flushLive = () => {};
        };
    });

    function togglePause() {
        if (!view.logPaused.current) flushLive();
        view.logPaused.current = !view.logPaused.current;
    }

    function reconnect() {
        view.logPaused.current = false;
        attempt++;
        reconnecting = false;
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

    async function search(older = false, dates?: { start: string; end: string }, preserveView = false) {
        if (view.logMode.current !== "search" || pending || !selectedIds.length || (older && (!submitted || !nextCursor))) return;
        const range = older && submitted ? submitted : { start: dates?.start ?? start, end: dates?.end ?? end, query: view.logText.current, serviceIds: [...selectedIds] };
        const from = Date.parse(range.start);
        const until = Date.parse(range.end);

        if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > 366 * 86_400_000) {
            searchError = "Choose valid dates with an end after the start, within a 366-day range.";

            return;
        }

        searchController?.abort();
        const controller = new AbortController();
        searchController = controller;
        const searchScope = scopeKey;
        const isCurrent = () => searchController === controller && !controller.signal.aborted && view.logMode.current === "search" && scopeKey === searchScope;
        pending = true;
        searchError = "";

        try {
            const normalized = { ...range, start: new Date(from).toISOString(), end: new Date(until).toISOString() };

            if (!older) {
                if (dates) void view.set({ logStart: normalized.start, logEnd: normalized.end });

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

            const result = await client.resources.searchLogs({ projectId, resourceId, ...normalized, cursor: older ? nextCursor ?? undefined : undefined }, { signal: controller.signal });

            if (!isCurrent()) return;
            historyLogs = [...historyLogs, ...decorate(result.logs)];
            nextCursor = result.nextCursor;
            searched = true;

            if (!older && !preserveView && viewport) viewport.scrollTop = 0;
        } catch (error) {
            if (isCurrent()) searchError = error instanceof Error ? error.message : "Unable to search logs.";
        } finally {
            if (searchController === controller) pending = false;
        }
    }

    function submitSearch(event: SubmitEvent) {
        event.preventDefault();

        if (view.logRange.current !== "custom") {
            const duration = view.logRange.current === "24h" ? 86_400_000 : view.logRange.current === "1h" ? 3_600_000 : 900_000;
            const now = new Date();
            void search(false, { start: localDate(new Date(now.getTime() - duration)), end: localDate(now) });

            return;
        }

        void search();
    }

    function time(value: string | number, full = false) {
        return new Date(value).toLocaleString(undefined, full ? { dateStyle: "medium", timeStyle: "medium" } : { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
    }

    onDestroy(() => searchController?.abort());
</script>

<svelte:head>{#if active}<title>Logs / {resourceQuery.data?.name ?? "Resource"} / Stoat</title>{/if}</svelte:head>

{#if active}
<div class="flex h-[calc(100dvh-7rem)] min-h-160 min-w-0 w-full flex-col gap-3 py-3 xl:h-auto xl:min-h-0 xl:flex-1">
{#if resourceQuery.isError}
    <Alert variant="error"><AlertDescription>{resourceQuery.error.message}</AlertDescription></Alert>
    <Button variant="outline" size="sm" class="self-start" onclick={() => resourceQuery.refetch()}>Try again</Button>
{:else if servicesQuery.isError || (streamError && !servicesQuery.data)}
    <Alert variant="error"><AlertDescription>{servicesQuery.error?.message ?? streamError}</AlertDescription></Alert>
    <Button variant="outline" size="sm" class="self-start" onclick={reconnect}>Try again</Button>
{:else if !loading && !services.length}
    <Empty class="flex-1 rounded-2xl border border-dashed">
        <EmptyHeader><EmptyTitle>No deployed services</EmptyTitle><EmptyDescription>Deploy this resource to view logs from its current services.</EmptyDescription></EmptyHeader>
        <Button variant="outline" size="sm" href="/projects/{projectId}/{resourceId}">Open resource</Button>
    </Empty>
{:else}
    <Skeleton {loading} loading-label="Loading logs" class="flex min-h-0 min-w-0 flex-1 flex-col" background-color="color-mix(in oklab, var(--foreground) 8%, transparent)" shimmer-color="color-mix(in oklab, var(--foreground) 6%, transparent)">
    <Frame inert={loading} class="min-h-0 min-w-0 flex-1 overflow-hidden {view.logMode.current === 'search' && view.logRange.current === 'custom' ? 'max-xl:min-h-192' : ''}">
        <FrameHeader class="shrink-0 gap-3 px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-1 rounded-lg bg-background/60 p-0.5" role="group" aria-label="Log source">
                    <Button variant={view.logMode.current === "live" ? "outline" : "ghost"} size="sm" aria-pressed={view.logMode.current === "live"} onclick={() => changeMode("live")}>Live</Button>
                    <Button variant={view.logMode.current === "search" ? "outline" : "ghost"} size="sm" aria-pressed={view.logMode.current === "search"} onclick={() => changeMode("search")}>Search</Button>
                </div>
                <Popover>
                    <PopoverTrigger class={buttonVariants({ variant: "outline", size: "sm" })}>
                        {selectedIds.length === services.length ? "All services" : `${selectedIds.length} services`}<ChevronDown class="size-3.5" aria-hidden="true" />
                    </PopoverTrigger>
                    <PopoverPopup align="start" class="w-80 max-w-[calc(100vw-2rem)]">
                        <PopoverTitle class="mb-2 text-sm font-medium">Services</PopoverTitle>
                        <Input size="sm" type="search" aria-label="Find a service" placeholder="Find a service..." bind:value={() => view.logServiceSearch.current, (value) => view.logServiceSearch.current = value} />
                        <div class="my-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>Select up to 20</span>
                            <Button variant="ghost" size="xs" onclick={() => view.logServices.current = (selection?.length ?? selectedIds.length) ? [] : services.slice(0, 20).map((service) => service.name)}>{(selection?.length ?? selectedIds.length) ? "Clear" : "Select all"}</Button>
                        </div>
                        <div class="max-h-64 space-y-1 overflow-y-auto">
                            {#each visibleServices as service (service.id)}
                                <label for={`log-service-${service.id}`} class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-muted">
                                    <Checkbox id={`log-service-${service.id}`} checked={selectedIds.includes(service.id)} onCheckedChange={(checked) => selectService(service.name, checked)} disabled={!selectedIds.includes(service.id) && (selection?.length ?? selectedIds.length) >= 20} />
                                    <span class="min-w-0 truncate text-sm" title={service.name}>{service.name}</span>
                                </label>
                            {/each}
                            {#if !visibleServices.length}<p class="py-3 text-sm text-muted-foreground">No matching services.</p>{/if}
                        </div>
                    </PopoverPopup>
                </Popover>
                <span data-shimmer-ignore class="min-w-16 flex-1 whitespace-nowrap text-xs text-muted-foreground"></span>
                {#if view.logMode.current === "live" && (loading || selectedIds.length)}
                    <span role="status"><Badge variant={status === "Live" ? "success" : failures.length || streamError ? "warning" : "secondary"}>{status}</Badge></span>
                    <Button variant="outline" size="sm" onclick={togglePause}>
                        {#if view.logPaused.current}<Play class="size-3.5" aria-hidden="true" />Resume{:else}<Pause class="size-3.5" aria-hidden="true" />Pause{/if}
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Reconnect live logs" title="Refresh services and reload recent tail" disabled={servicesQuery.isFetching} onclick={reconnect}><RefreshCw class="size-3.5" aria-hidden="true" /></Button>
                {/if}
            </div>
            {#if view.logMode.current === "live"}
                <Input size="sm" type="search" aria-label="Filter loaded logs" placeholder="Filter loaded logs..." bind:value={() => view.logText.current, (value) => view.logText.current = value} />
            {:else if servicesQuery.data?.historyAvailable}
                <form class="flex flex-col gap-2" onsubmit={submitSearch}>
                    <div class="flex flex-wrap items-center gap-2">
                        <div class="min-w-40 flex-1"><Input size="sm" type="search" aria-label="Search log messages" placeholder="Search messages (literal text)..." bind:value={() => view.logText.current, (value) => view.logText.current = value} maxlength={512} /></div>
                        <label class="sr-only" for="log-range">Time range</label>
                        <select id="log-range" class="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7" value={view.logRange.current} onchange={(event) => chooseRange(event.currentTarget.value)}>
                            <option value="15m">Last 15 minutes</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="custom">Custom range</option>
                        </select>
                        <Button size="sm" type="submit" loading={pending} disabled={pending || !selectedIds.length}><Search class="size-3.5" aria-hidden="true" />Search</Button>
                    </div>
                    {#if view.logRange.current === "custom"}
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div class="space-y-1"><Label for="log-start" class="text-xs">From</Label><Input id="log-start" size="sm" type="datetime-local" step="1" bind:value={() => start, (value) => setDateInput("logStart", value)} required /></div>
                            <div class="space-y-1"><Label for="log-end" class="text-xs">Until</Label><Input id="log-end" size="sm" type="datetime-local" step="1" bind:value={() => end, (value) => setDateInput("logEnd", value)} required /></div>
                        </div>
                    {/if}
                    <p class="text-xs text-muted-foreground">{timezone}. {servicesQuery.data.retentionDays ? `Up to ${servicesQuery.data.retentionDays} days retained.` : "Within configured retention."} Current service IDs only.</p>
                </form>
            {/if}
        </FrameHeader>

        {#if view.logMode.current === "search" && !servicesQuery.data?.historyAvailable}
            <FramePanel class="flex min-h-0 flex-1 items-center justify-center">
                <Empty><EmptyHeader><EmptyTitle>Historical logs unavailable</EmptyTitle><EmptyDescription>Initialize cluster monitoring to store and search logs in GreptimeDB. Live logs are still available.</EmptyDescription></EmptyHeader><Button variant="outline" size="sm" onclick={() => changeMode("live")}>View live logs</Button></Empty>
            </FramePanel>
        {:else}
            <FramePanel class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0">
                <LogViewer
                    logs={matchedLogs}
                    {loading}
                    {pending}
                    follow={view.logMode.current === "live"}
                    start={view.logMode.current === "search" && submitted ? Date.parse(submitted.start) : undefined}
                    end={view.logMode.current === "search" && submitted ? Date.parse(submitted.end) : undefined}
                    highlight={view.logMode.current === "live" ? view.logText.current : ""}
                    note={view.logMode.current === "search" && searched ? "Newest first" : ""}
                    source={(log) => log.container ?? "Unknown container"}
                    bind:viewport
                    bind:level={() => view.logLevel.current, (value) => view.logLevel.current = value}
                    bind:bucket={() => view.logBucket.current, (value) => view.logBucket.current = value}
                    bind:wrap={() => view.logWrap.current, (value) => view.logWrap.current = value}
                    bind:clean={() => view.logClean.current, (value) => view.logClean.current = value}
                    bind:following={() => view.logFollowing.current, (value) => view.logFollowing.current = value}
                    bind:scroll={() => view.logScroll.current, (value) => view.logScroll.current = value}
                    bind:entry={() => view.logEntry.current, (value) => view.logEntry.current = value}
                >
                    {#if streamError && view.logMode.current === "live"}
                        <Alert variant={reconnecting ? "warning" : "error"} class="m-2 shrink-0 px-3 py-2"><AlertDescription>{streamError} {#if reconnecting}Retrying with a fresh recent tail.{/if}</AlertDescription></Alert>
                    {/if}
                    {#if view.logMode.current === "live" && failures.length}
                        <div class="shrink-0 border-b px-3 py-2 text-xs text-warning-foreground" role="status">
                            {#each failures as failure (failure.id)}<p>{services.find((service) => service.id === failure.id)?.name}: {failure.message ?? "Stream unavailable. Reconnect to retry."}</p>{/each}
                        </div>
                    {/if}
                    {#if searchError}<Alert variant="error" class="m-2 shrink-0 px-3 py-2"><AlertDescription>{searchError}</AlertDescription></Alert>{/if}

                    {#snippet details(log)}
                        <div><dt class="inline text-muted-foreground">Service </dt><dd class="inline font-mono wrap-anywhere">{log.serviceName}</dd></div>
                        <div><dt class="inline text-muted-foreground">Machine </dt><dd class="inline font-mono wrap-anywhere">{log.machine ? (machineNames.get(log.machine) ?? log.machine) : "Not recorded"}</dd></div>
                        <div><dt class="inline text-muted-foreground">Container </dt><dd class="inline font-mono wrap-anywhere">{log.container ?? "Not recorded"}</dd></div>
                        <div><dt class="inline text-muted-foreground">Stream </dt><dd class="inline font-mono">{log.stream ?? "Not recorded"}</dd></div>
                    {/snippet}

                    {#snippet empty()}
                        {#if !selectedIds.length}
                            <Empty class="h-full"><EmptyHeader><EmptyTitle>Select a service</EmptyTitle><EmptyDescription>Choose one or more services to view their logs.</EmptyDescription></EmptyHeader></Empty>
                        {:else if view.logMode.current === "search" && !searched && !pending}
                            <Empty class="h-full"><EmptyHeader><EmptyTitle>Search stored logs</EmptyTitle><EmptyDescription>Choose a time range and search. Leave the message field empty to see all logs.</EmptyDescription></EmptyHeader></Empty>
                        {:else}
                            <Empty class="h-full"><EmptyHeader><EmptyTitle>{pending ? "Searching logs..." : view.logMode.current === "live" ? "Waiting for logs" : "No matching logs"}</EmptyTitle><EmptyDescription>{view.logMode.current === "live" ? "New output from selected services appears here." : "Try a wider time range, different services, or a shorter search."}</EmptyDescription></EmptyHeader></Empty>
                        {/if}
                    {/snippet}
                </LogViewer>

                <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                    {#if view.logMode.current === "live"}
                        <span>{timezone}</span>
                    {:else}
                        <p class="min-w-0 flex-1 truncate" title={searchSummary}>{searchSummary}</p>
                        {#if nextCursor}<Button variant="outline" size="sm" loading={pending} disabled={pending || historyLogs.length >= 2000} onclick={() => search(true)}>Load older</Button>{/if}
                        {#if historyLogs.length >= 2000 && nextCursor}<span>Narrow the range to browse more than 2,000 lines.</span>{/if}
                    {/if}
                </div>
            </FramePanel>
        {/if}
    </Frame>
    </Skeleton>
{/if}
</div>
{/if}
