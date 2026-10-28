import { client, orpc, queryClient } from "$lib/api/orpc";
import { streamErrorToast, subscribeToStream } from "$lib/deployments/stream";
import {
    classifyLog,
    liveStreamStatus,
    logByteCost,
    logEntryKey,
    selectedLogServices,
    trimLogLines,
    type DisplayLog,
    type LogServiceState,
} from "$lib/resources/logs";
import type { ResourceLog } from "@stoat/api/routers/resources/logs";
import { untrack } from "svelte";

export type ViewLog = DisplayLog & { key: string };

let nextId = 0;

export function decorateLogs(entries: ResourceLog[]): ViewLog[] {
    return entries.map((entry) => ({
        ...entry,
        id: nextId++,
        key: logEntryKey(entry),
        time: Date.parse(entry.timestamp),
        level: classifyLog(entry.message),
    }));
}

/**
 * A resource's live log tail, shared by the resource logs page and the canvas panel.
 * Create it while a component initialises; it follows the getters and stops with the component.
 */
export class LogStream {
    logs = $state.raw<ViewLog[]>([]);

    discarded = $state(0);

    error = $state("");

    reconnecting = $state(false);

    serviceStates = $state<LogServiceState[]>([]);

    attempt = $state(0);

    /** Changes when the streamed selection does; service IDs can churn during a deployment without it. */
    scopeKey = $derived.by(() => {
        const names = this.getNames();

        return `${this.getProjectId()}/${this.getResourceId()}/${names === null ? "all" : names.join(",")}`;
    });

    failures = $derived(
        this.serviceStates.filter(
            (service) => service.state === "error" || service.state === "reconnecting",
        ),
    );

    status = $derived.by(() =>
        liveStreamStatus(
            this.getPaused(),
            this.reconnecting,
            this.error,
            this.serviceStates,
            this.getSelectedIds().length,
        ),
    );

    // Replaced by each open stream so the pause button can show what is buffered.
    flush = () => {};

    private toast = streamErrorToast();

    constructor(
        private getProjectId: () => string,
        private getResourceId: () => string,
        /** Selected service names; null streams every service. */
        private getNames: () => string[] | null,
        private getSelectedIds: () => string[],
        private getPaused: () => boolean,
        private getEnabled: () => boolean,
    ) {
        $effect.pre(() => {
            void this.scopeKey;
            this.logs = [];
            this.discarded = 0;
            this.error = "";
            this.reconnecting = false;
            this.serviceStates = [];
        });

        $effect(() => this.open());
    }

    reconnect() {
        this.attempt++;
        this.reconnecting = false;
    }

    // Tracks selection intent, not IDs that can change during a deployment.
    private open() {
        void this.scopeKey;

        const names = untrack(() => {
            const selection = this.getNames();

            return selection === null ? null : [...selection];
        });

        const scope = { projectId: this.getProjectId(), resourceId: this.getResourceId() };

        const servicesKey = orpc.resources.listLogServices.queryKey({ input: scope });

        void this.attempt;

        if (!this.getEnabled() || this.getPaused() || names?.length === 0) return;

        this.reconnecting = false;
        let incoming: ResourceLog[] = [];
        let overflow = false;
        let incomingBytes = 0;
        let replaceTail = true;
        let stop = () => {};

        const flush = () => {
            if (!incoming.length) return;

            const combined = [...(replaceTail ? [] : this.logs), ...decorateLogs(incoming)].sort(
                (a, b) => a.timestamp.localeCompare(b.timestamp),
            );

            if (replaceTail) this.discarded = 0;
            replaceTail = false;
            incoming = [];
            incomingBytes = 0;

            const { kept, removed } = trimLogLines(combined, 1000000, 100 * 1024 * 1024);

            this.discarded += removed;
            this.logs = kept;
        };

        const timer = setInterval(flush, 100);
        this.flush = flush;
        stop = untrack(() =>
            subscribeToStream(
                (signal) => {
                    // Uncloud reconnects replay the recent tail, not an exactly-once cursor.
                    // Keep the previous buffer visible until the first replay batch arrives.
                    replaceTail = true;
                    incoming = [];
                    incomingBytes = 0;
                    this.error = "";
                    this.serviceStates = this.getSelectedIds().map((id) => ({
                        id,
                        state: "connecting",
                    }));

                    // Resolve names and open current IDs together on the server, avoiding a refetch/open race.
                    return this.toast.connected(
                        client.resources.streamLogs(
                            { ...scope, serviceNames: names ?? undefined },
                            { signal },
                        ),
                    );
                },
                (event) => {
                    this.reconnecting = false;

                    if (event.type === "services") {
                        if (event.services.length === 0) {
                            this.logs = [];
                            this.discarded = 0;
                        }

                        queryClient.setQueryData(servicesKey, {
                            services: event.services,
                            historyAvailable: event.historyAvailable,
                            retentionDays: event.retentionDays,
                        });
                        this.serviceStates = selectedLogServices(event.services, names).map(
                            (service) => ({ id: service.id, state: "connecting" }),
                        );
                    } else if (event.type === "reset") {
                        this.logs = this.logs.filter((log) => log.serviceId !== event.serviceId);
                        incoming = incoming.filter((log) => log.serviceId !== event.serviceId);
                        incomingBytes = incoming.reduce(
                            (sum, log) => sum + logByteCost(log.message),
                            0,
                        );

                        const replacement = event.replacement;

                        if (replacement) {
                            queryClient.setQueryData(servicesKey, (current) =>
                                current
                                    ? {
                                          ...current,
                                          services: current.services.map((service) =>
                                              service.id === event.serviceId
                                                  ? replacement
                                                  : service,
                                          ),
                                      }
                                    : current,
                            );
                            this.serviceStates = this.serviceStates.map((service) =>
                                service.id === event.serviceId
                                    ? { id: replacement.id, state: "connecting" }
                                    : service,
                            );
                        }
                    } else if (event.type === "status") {
                        this.serviceStates = this.serviceStates.map((service) =>
                            service.id === event.serviceId
                                ? {
                                      id: service.id,
                                      state: event.state,
                                      message: event.message,
                                  }
                                : service,
                        );
                    } else {
                        for (const log of event.logs) {
                            incoming.push(log);
                            incomingBytes += logByteCost(log.message);
                        }

                        if (incoming.length > 2000 || incomingBytes > 4 * 1024 * 1024) {
                            flush();
                            overflow = true;
                            this.error =
                                "Log volume exceeded the live buffer. Reconnect or search a time range.";
                            clearInterval(timer);
                            stop();
                        }
                    }
                },
                (error, retrying) => {
                    flush();
                    this.error = error.message;
                    this.reconnecting = retrying;

                    // A stopped stream shows its error inline next to the reconnect button.
                    if (retrying) this.toast.show(error, true);
                    else {
                        this.toast.clear();
                        clearInterval(timer);
                    }
                },
                () => {
                    const ended =
                        overflow ||
                        (this.serviceStates.length > 0 &&
                            this.serviceStates.every((service) => service.state === "error"));

                    if (ended) {
                        flush();
                        clearInterval(timer);
                    }

                    return ended;
                },
                ["BAD_GATEWAY"],
            ),
        );

        return () => {
            clearInterval(timer);
            stop();
            this.toast.clear();
            this.flush = () => {};
        };
    }
}
