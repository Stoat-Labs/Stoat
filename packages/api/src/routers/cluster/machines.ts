import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { forgetJoinedMachine, latestMachineAttempt } from "@stoat/db/clusters";
import { clusters, deployments } from "@stoat/db/schema/index";
import { UcApiError, unwrap } from "@stoat/uncloud";
import { addMachineLock } from "@stoat/workflows/add-machine";
import { sshKeyPair } from "@stoat/workflows/ssh-setup";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { organizationAdminProcedure, uncloudMiddleware } from "../..";
import { assertNoAttempt, assertReachableHost, serverInput } from "./provisioning";

const clusterId = v.pipe(v.string(), v.uuid());

const clusterInput = v.object({ clusterId });

const machineId = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/, "Invalid machine ID."));

// Uncloud's machine name rule: a lowercase DNS label that isn't a DNS query mode or an ID.
const machineName = v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.regex(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
        "Use up to 63 letters, digits and hyphens, starting and ending with a letter or digit.",
    ),
    v.check(
        (name) => name !== "rr" && name !== "nearest" && !/^[0-9a-f]{32}$/.test(name),
        "Uncloud keeps this name for itself. Choose another one.",
    ),
);

type Transaction = Pick<Database, "select">;

/** How far adding the pending server got: waiting for its key, or its latest attempt. */
export function pendingMachineStatus(attempt: string | undefined) {
    if (!attempt) return "pending" as const;

    if (attempt === "queued") return "queued" as const;

    if (attempt === "running") return "running" as const;

    // Failed and cancelled attempts are retried the same way.
    return "failed" as const;
}

/** The organization's cluster, locked so its pending machine changes one request at a time. */
async function lockCluster(tx: Transaction, organizationId: string, clusterId: string) {
    const [cluster] = await tx
        .select({
            id: clusters.id,
            provisioning: clusters.provisioning,
            pendingMachine: clusters.pendingMachine,
        })
        .from(clusters)
        .where(and(eq(clusters.id, clusterId), eq(clusters.organizationId, organizationId)))
        .for("update");

    if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

    // Machines join through the sidecar, which a cluster still being set up doesn't have yet.
    if (cluster.provisioning)
        throw new ORPCError("PRECONDITION_FAILED", {
            message: "This cluster is still being set up.",
        });

    return cluster;
}

/** Refuses while an attempt runs, a cancelled one is still stopping, or a machine is being removed. */
function assertIdle(tx: Pick<Database, "select" | "execute">, clusterId: string) {
    return assertNoAttempt(tx, clusterId, "AddMachine", addMachineLock(clusterId));
}

/** Explains why the sidecar didn't remove a machine. */
function removalError(error: Error) {
    // The sidecar keeps going on its own, so the machine may still disappear.
    if (error.name === "TimeoutError")
        return new ORPCError("GATEWAY_TIMEOUT", {
            message:
                "Removing the machine is taking long. Check the machines list again in a minute.",
        });

    if (!(error instanceof UcApiError)) return error;

    // Older sidecars only answer GET and PATCH for a machine.
    if (error.status === 405)
        return new ORPCError("PRECONDITION_FAILED", {
            message:
                "This cluster's sidecar is too old to remove machines. Update the Stoat sidecar, then try again.",
        });

    if (error.status === 404)
        return new ORPCError("NOT_FOUND", { message: "This machine is no longer in the cluster." });

    // The sidecar is still removing a machine, which can outlast Stoat's wait for it.
    if (error.status === 409)
        return new ORPCError("CONFLICT", {
            message: "Another machine is still being removed. Try again once it's gone.",
        });

    return new ORPCError(error.status < 500 ? "BAD_REQUEST" : "BAD_GATEWAY", {
        message: error.message,
    });
}

export const machinesRouter = {
    // Saves the server to add with a new single-use key; adding it starts once the key is authorized.
    prepareMachine: organizationAdminProcedure
        .input(v.object({ clusterId, ...serverInput, name: v.optional(machineName) }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            assertReachableHost(input.host);

            return db.transaction(async (tx) => {
                const cluster = await lockCluster(tx, organizationId, input.clusterId);

                if (cluster.pendingMachine)
                    throw new ORPCError("CONFLICT", {
                        message: "Finish or discard the server already waiting to be added.",
                    });

                // The comment tells the user which authorized key to remove later.
                const key = sshKeyPair(`stoat-${cluster.id.slice(0, 8)}`);

                await tx
                    .update(clusters)
                    .set({
                        pendingMachine: {
                            host: input.host,
                            port: input.port,
                            user: input.user,
                            name: input.name ?? null,
                            publicKey: key.publicKey,
                            preparedAt: new Date().toISOString(),
                            joined: null,
                        },
                        pendingMachineKey: key.privateKey,
                    })
                    .where(eq(clusters.id, cluster.id));

                return { publicKey: key.publicKey };
            });
        }),

    // What to authorize and how far adding the server got; null when none is waiting.
    getPendingMachine: organizationAdminProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({ id: clusters.id, pendingMachine: clusters.pendingMachine })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            const pending = cluster.pendingMachine;

            if (!pending) return null;

            const attempt = await latestMachineAttempt(db, cluster.id, pending.preparedAt);

            return {
                host: pending.host,
                port: pending.port,
                user: pending.user,
                name: pending.joined?.name ?? pending.name,
                publicKey: pending.publicKey,
                joined: pending.joined !== null,
                status: pendingMachineStatus(attempt?.status),
                deploymentId: attempt?.id ?? null,
            };
        }),

    // Starts or retries adding the pending server. The queued deployment is the outbox.
    addMachine: organizationAdminProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const cluster = await lockCluster(tx, organizationId, input.clusterId);

                if (!cluster.pendingMachine)
                    throw new ORPCError("CONFLICT", {
                        message: "No server is waiting to be added.",
                    });

                await assertIdle(tx, cluster.id);

                const deploymentId = randomUUID();

                await tx.insert(deployments).values({
                    id: deploymentId,
                    jobId: deploymentId,
                    clusterId: cluster.id,
                    name: "AddMachine",
                    status: "queued",
                });

                return { deploymentId };
            }),
        ),

    // Forgets the pending server and deletes its key. A server that already joined stays in the cluster.
    discardPendingMachine: organizationAdminProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const cluster = await lockCluster(tx, organizationId, input.clusterId);

                await assertIdle(tx, cluster.id);
                await tx
                    .update(clusters)
                    .set({ pendingMachine: null, pendingMachineKey: null })
                    .where(eq(clusters.id, cluster.id));

                return { id: cluster.id };
            }),
        ),

    // Like `uc machine rm`: removes its containers and resets it when it answers, then drops it from the cluster.
    removeMachine: organizationAdminProcedure
        .input(v.object({ clusterId, machineId }))
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, uc }, input }) =>
            // Holding the add lock until it's removed keeps an attempt from adding or spreading to it meanwhile.
            db.transaction(async (tx) => {
                await assertIdle(tx, input.clusterId);

                const removed = await unwrap(
                    uc.DELETE("/api/v1/machines/{id}", {
                        params: { path: { id: input.machineId } },
                        signal: AbortSignal.timeout(120_000),
                    }),
                ).catch((error: Error) => {
                    throw removalError(error);
                });

                await forgetJoinedMachine(tx, input.clusterId, input.machineId);

                return { name: removed.name, reset: removed.reset };
            }),
        ),
};
