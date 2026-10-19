import { client, orpc, queryClient } from "$lib/api/orpc";
import { classifyLog, type LogRow } from "$lib/resources/logs";
import { untrack } from "svelte";
import {
    deploymentStatusLabel,
    deploymentStatusVariant,
    isActiveDeploymentStatus,
    isTerminalDeploymentStatus,
} from "./status";
import { deploymentSteps } from "./steps";
import { subscribeToStream } from "./stream";

type DeploymentEvent =
    Awaited<ReturnType<typeof client.cluster.streamDeployment>> extends AsyncIterable<infer T>
        ? T
        : never;

export type DeploymentRow = LogRow & { event?: string };

function toRow(line: DeploymentEvent["logs"][number]): DeploymentRow {
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
        event: line.metadata?.event,
    };
}

/**
 * A deployment's live state: its snapshot plus streamed log lines, shared by the deployment page and the canvas panel.
 * Create it while a component initialises; it follows `getId` and stops with the component.
 */
export class DeploymentStream {
    deployment = $state<DeploymentEvent["deployment"] | null>(null);

    // Names come from the snapshot only: stream events carry no project or resource names.
    origin = $state<{
        projectId: string | null;
        projectName: string | null;
        resourceName: string | null;
    }>({ projectId: null, projectName: null, resourceName: null });

    rows = $state.raw<DeploymentRow[]>([]);

    cancelAllowed = $state(false);

    streamError = $state("");

    reconnecting = $state(false);

    now = $state(Date.now());

    status = $derived(this.deployment?.status ?? "queued");

    isActive = $derived(isActiveDeploymentStatus(this.status));

    // A queued deployment carrying an error is waiting for its next attempt.
    retrying = $derived(this.status === "queued" && !!this.deployment?.error);

    statusLabel = $derived(deploymentStatusLabel(this.status, this.retrying));

    statusVariant = $derived(deploymentStatusVariant(this.status));

    canCancel = $derived(this.cancelAllowed && this.isActive);

    canDelete = $derived(this.cancelAllowed && !this.isActive && !!this.deployment);

    steps = $derived(
        deploymentSteps(
            this.rows.filter((row) => !row.muted),
            this.isActive,
        ),
    );

    startedAt = $derived(this.deployment ? new Date(this.deployment.createdAt).getTime() : 0);

    durationMs = $derived(
        this.deployment
            ? Math.max(
                  0,
                  (this.deployment.finishedAt
                      ? new Date(this.deployment.finishedAt).getTime()
                      : this.now) - this.startedAt,
              )
            : null,
    );

    /** @param onReset runs whenever a different deployment is loaded, before its data arrives. */
    constructor(getId: () => string, onReset: () => void) {
        $effect(() => this.follow(getId(), onReset));

        $effect(() => {
            if (!this.isActive) return;
            const timer = setInterval(() => (this.now = Date.now()), 1000);

            return () => clearInterval(timer);
        });
    }

    /** Elapsed since the deployment started, e.g. 00:07 or 01:02:07. */
    offset = (value: Date | string) => {
        const ms = Math.max(0, new Date(value).getTime() - this.startedAt);

        return new Date(ms).toISOString().slice(ms >= 3_600_000 ? 11 : 14, 19);
    };

    private follow(id: string, onReset: () => void) {
        if (!id) return;

        this.deployment = null;
        this.origin = { projectId: null, projectName: null, resourceName: null };
        this.rows = [];
        this.cancelAllowed = false;
        this.streamError = "";
        this.reconnecting = false;
        // View state setters read their own state; tracking it would restart the stream on every view change.
        untrack(onReset);

        let disposed = false;
        let stopStream: (() => void) | undefined;
        let afterId = 0;
        let completed = false;
        let streamComplete = false;
        const rawLogs: DeploymentEvent["logs"] = [];

        // IDs are ordered by the server, including chunked replay and reconnects.
        const appendLines = (lines: DeploymentEvent["logs"]) => {
            const fresh = lines.filter((line) => line.id > afterId);

            if (!fresh.length) return;
            this.rows = this.rows.concat(fresh.map(toRow));
            rawLogs.push(...fresh);
            afterId = fresh.at(-1)!.id;
        };

        const startStream = () => {
            stopStream = subscribeToStream(
                (signal) =>
                    client.cluster.streamDeployment({ deploymentId: id, afterId }, { signal }),
                (event) => {
                    if (disposed) return;
                    streamComplete = event.complete;
                    this.deployment = event.deployment;
                    this.cancelAllowed = event.canCancel;
                    this.streamError = "";
                    this.reconnecting = false;
                    appendLines(event.logs);

                    if (!completed && isTerminalDeploymentStatus(event.deployment.status)) {
                        completed = true;
                        // Cache the finished deployment so revisits render without a stream.
                        // Narrow invalidation keeps this entry fresh while lists still refresh.
                        queryClient.setQueryData(
                            orpc.cluster.getDeployment.queryKey({
                                input: { deploymentId: id },
                            }),
                            {
                                ...event.deployment,
                                ...this.origin,
                                logs: rawLogs,
                                canCancel: event.canCancel,
                            },
                        );
                        void queryClient.invalidateQueries({
                            queryKey: orpc.cluster.listAllDeployments.key(),
                        });
                        void queryClient.invalidateQueries({
                            queryKey: orpc.cluster.listDeployments.key(),
                        });
                        void queryClient.invalidateQueries({
                            queryKey: orpc.cluster.getCluster.queryKey({
                                input: { clusterId: event.deployment.clusterId },
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
                    this.streamError = error.message || "Unable to stream deployment logs.";
                    this.reconnecting = retrying;
                },
                () => streamComplete,
            );
        };

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
                    canCancel,
                    projectId,
                    projectName,
                    resourceName,
                    ...snapshotDeployment
                } = snapshot;

                this.deployment = snapshotDeployment;
                this.origin = { projectId, projectName, resourceName };
                this.cancelAllowed = canCancel;
                this.rows = snapshotLogs.map(toRow);
                rawLogs.push(...snapshotLogs);
                afterId = snapshotLogs.at(-1)?.id ?? 0;

                if (isTerminalDeploymentStatus(snapshotDeployment.status)) {
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
    }
}
