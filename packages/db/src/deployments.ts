import { and, asc, desc, eq, getTableColumns, gt, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { Client, type Notification } from "pg";
import type { Database } from "./index";
import {
    type ClusterInitializationConfiguration,
    deploymentLogs,
    deployments,
    type DeploymentStatus,
    projects,
    resources,
} from "./schema";

export type Deployment = typeof deployments.$inferSelect;

export type DeploymentLog = typeof deploymentLogs.$inferSelect;

const MAX_LOGS = 2000;

export async function createDeployment(
    db: Pick<Database, "insert">,
    input: {
        clusterId: string;
        name: string;
        jobId: string;
        resourceId?: string | null;
        spec?: string | null;
        configuration?: ClusterInitializationConfiguration | null;
    },
) {
    const [row] = await db
        .insert(deployments)
        .values({
            id: randomUUID(),
            clusterId: input.clusterId,
            name: input.name,
            status: "queued",
            jobId: input.jobId,
            resourceId: input.resourceId ?? null,
            spec: input.spec ?? null,
            configuration: input.configuration ?? null,
        })
        .returning();

    return row!;
}

export async function getDeploymentByJobId(db: Database, jobId: string) {
    const [row] = await db.select().from(deployments).where(eq(deployments.jobId, jobId)).limit(1);

    return row ?? null;
}

export async function setDeploymentStatus(
    db: Database,
    id: string,
    status: DeploymentStatus,
    error: string | null = null,
) {
    await db
        .update(deployments)
        .set({
            status,
            error,
            ...(status === "ready" || status === "failed" || status === "cancelled"
                ? { finishedAt: new Date() }
                : { finishedAt: null }),
        })
        .where(and(eq(deployments.id, id), ne(deployments.status, "cancelled")));
}

/** Atomically mark an active deployment cancelled. Returns null when it already settled. */
export async function cancelDeployment(db: Database, id: string) {
    const [row] = await db
        .update(deployments)
        .set({
            status: "cancelled",
            error: "Cancelled by user.",
            finishedAt: new Date(),
        })
        .where(and(eq(deployments.id, id), inArray(deployments.status, ["queued", "running"])))
        .returning();

    return row ?? null;
}

/** Delete a settled deployment (logs cascade). Returns null while it is still active. */
export async function deleteSettledDeployment(db: Database, id: string) {
    const [row] = await db
        .delete(deployments)
        .where(
            and(
                eq(deployments.id, id),
                inArray(deployments.status, ["ready", "failed", "cancelled"]),
            ),
        )
        .returning({ id: deployments.id });

    return row ?? null;
}

export async function appendDeploymentLog(
    db: Database,
    deploymentId: string,
    text: string,
    metadata: DeploymentLog["metadata"] = {},
) {
    const line = text.trim();

    if (!line) return;
    await db.insert(deploymentLogs).values({ deploymentId, text: line, metadata });
}

export function listDeployments(db: Database, clusterId: string, limit = 20) {
    return db
        .select()
        .from(deployments)
        .where(eq(deployments.clusterId, clusterId))
        .orderBy(desc(deployments.createdAt))
        .limit(limit);
}

export async function getDeploymentWithLogs(db: Database, id: string) {
    const [row] = await db
        .select({
            ...getTableColumns(deployments),
            resourceName: resources.name,
            projectId: projects.id,
            projectName: projects.name,
        })
        .from(deployments)
        .leftJoin(resources, eq(deployments.resourceId, resources.id))
        .leftJoin(projects, eq(resources.projectId, projects.id))
        .where(eq(deployments.id, id))
        .limit(1);

    if (!row) return null;

    const logs = await db
        .select()
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, id))
        .orderBy(asc(deploymentLogs.id))
        .limit(MAX_LOGS);

    return { ...row, logs };
}

/** The newest lines of a deployment's log, oldest first, so a long log still shows how it ends. */
export async function latestDeploymentLogs(db: Database, deploymentId: string) {
    const newest = await db
        .select()
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, deploymentId))
        .orderBy(desc(deploymentLogs.id))
        .limit(MAX_LOGS);

    return newest.reverse();
}

type ChangeSubscriber = {
    deploymentId?: string;
    pending: Map<string, string>;
    failure?: Error;
    wake?: () => void;
};

type ChannelListener = {
    client: Client;
    ready: Promise<void>;
    subscribers: Set<ChangeSubscriber>;
};

// One LISTEN connection per database and channel, shared by every subscriber in this process.
const channelListeners = new WeakMap<Database, Map<string, ChannelListener>>();

function openChannel(db: Database, channel: string, channels: Map<string, ChannelListener>) {
    // LISTEN requires a session, not a transaction-pooled connection. Keep the long-lived
    // listener outside the query pool so subscribers cannot starve their own reads.
    const client = new Client(db.$client.options);
    const subscribers = new Set<ChangeSubscriber>();

    // A broken connection fails its current subscribers; the next one opens a fresh listener.
    const fail = (error: Error) => {
        if (channels.get(channel) === listener) channels.delete(channel);

        for (const subscriber of subscribers) {
            subscriber.failure ??= error;
            subscriber.wake?.();
        }
    };

    client.on("notification", (notification: Notification) => {
        if (notification.channel !== channel || !notification.payload) return;

        // The trigger sends two UUIDs separated by ':', never log text or Compose input.
        const [id, clusterId] = notification.payload.split(":");

        if (!id || !clusterId) return;

        for (const subscriber of subscribers) {
            if (subscriber.deploymentId && subscriber.deploymentId !== id) continue;

            subscriber.pending.set(id, clusterId);
            subscriber.wake?.();
        }
    });
    client.on("error", fail);
    client.on("end", () => fail(new Error("Deployment notification connection closed.")));

    const ready = client.connect().then(async () => {
        await client.query(`LISTEN ${channel}`);
    });

    ready.catch(fail);

    const listener: ChannelListener = { client, ready, subscribers };

    return listener;
}

function joinChannel(db: Database, channel: string, subscriber: ChangeSubscriber) {
    let channels = channelListeners.get(db);

    if (!channels) {
        channels = new Map();
        channelListeners.set(db, channels);
    }

    let listener = channels.get(channel);

    if (!listener) {
        listener = openChannel(db, channel, channels);
        channels.set(channel, listener);
    }

    listener.subscribers.add(subscriber);

    return listener;
}

async function leaveChannel(
    db: Database,
    channel: string,
    listener: ChannelListener,
    subscriber: ChangeSubscriber,
) {
    listener.subscribers.delete(subscriber);

    if (listener.subscribers.size > 0) return;

    // Unregister before closing, so a subscriber joining meanwhile opens a fresh listener.
    const channels = channelListeners.get(db);

    if (channels?.get(channel) === listener) channels.delete(channel);

    await listener.client.end().catch(() => undefined);
}

/** The null IDs are a subscription-ready event: invalidate once to close the list/read race. */
export async function* watchDeploymentChanges(
    db: Database,
    options: { signal?: AbortSignal; deploymentId?: string; includeLogs?: boolean } = {},
): AsyncGenerator<{ deploymentId: string | null; clusterId: string | null }> {
    const { signal, deploymentId, includeLogs = true } = options;
    const channel = includeLogs ? "deployment_changes" : "deployment_list_changes";

    if (signal?.aborted) return;

    const subscriber: ChangeSubscriber = { deploymentId, pending: new Map() };
    const listener = joinChannel(db, channel, subscriber);
    const abort = () => subscriber.wake?.();

    signal?.addEventListener("abort", abort, { once: true });

    try {
        // pg can leave connect() pending when end() interrupts the handshake.
        const interrupted = new Promise<void>((resolve) => {
            subscriber.wake = resolve;
        });

        await Promise.race([listener.ready, interrupted]);
        subscriber.wake = undefined;

        if (signal?.aborted) return;

        if (subscriber.failure) throw subscriber.failure;

        // Notifications are already buffered before the caller performs its first read.
        yield { deploymentId: null, clusterId: null };

        while (!signal?.aborted) {
            if (subscriber.failure) throw subscriber.failure;

            if (subscriber.pending.size === 0) {
                await new Promise<void>((resolve) => {
                    subscriber.wake = resolve;
                });
                subscriber.wake = undefined;
                continue;
            }

            for (const [id, clusterId] of subscriber.pending) {
                subscriber.pending.delete(id);

                if (signal?.aborted) return;

                yield { deploymentId: id, clusterId };
            }
        }
    } catch (error) {
        if (!signal?.aborted) throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
        await leaveChannel(db, channel, listener, subscriber);
    }
}

/** Replay all committed logs, then read only on notifications. Final logs precede terminal status. */
export async function* watchDeployment(
    db: Database,
    id: string,
    options: { afterId?: number; signal?: AbortSignal } = {},
): AsyncGenerator<{ deployment: Deployment; logs: DeploymentLog[]; complete: boolean }> {
    let cursor = options.afterId ?? 0;

    for await (const _change of watchDeploymentChanges(db, { ...options, deploymentId: id })) {
        const [deployment] = await db.select().from(deployments).where(eq(deployments.id, id));

        if (!deployment || options.signal?.aborted) return;

        let logs: DeploymentLog[];

        do {
            logs = await db
                .select()
                .from(deploymentLogs)
                .where(and(eq(deploymentLogs.deploymentId, id), gt(deploymentLogs.id, cursor)))
                .orderBy(asc(deploymentLogs.id))
                .limit(MAX_LOGS);

            if (options.signal?.aborted) return;

            cursor = logs.at(-1)?.id ?? cursor;
            yield {
                deployment,
                logs,
                complete:
                    ["ready", "failed", "cancelled"].includes(deployment.status) &&
                    logs.length < MAX_LOGS,
            };
        } while (logs.length === MAX_LOGS);

        if (["ready", "failed", "cancelled"].includes(deployment.status)) return;
    }
}
