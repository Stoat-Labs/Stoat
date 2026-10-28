import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "./index";
import {
    clusterProvisionLogs,
    clusterProvisions,
    clusters,
    type ClusterProvisionInitState,
} from "./schema";

export type ClusterProvision = typeof clusterProvisions.$inferSelect;

export async function getProvision(db: Database, id: string) {
    const [row] = await db.select().from(clusterProvisions).where(eq(clusterProvisions.id, id));

    return row ?? null;
}

export async function appendProvisionLog(
    db: Database,
    provisionId: string,
    text: string,
    level: "info" | "error" = "info",
) {
    const line = text.trim();

    if (!line) return;
    await db.insert(clusterProvisionLogs).values({ provisionId, text: line, level });
}

export async function setProvisionStatus(
    db: Database,
    id: string,
    status: "running" | "failed",
    error: string | null,
) {
    await db
        .update(clusterProvisions)
        .set({ status, error })
        .where(
            and(
                eq(clusterProvisions.id, id),
                inArray(clusterProvisions.status, ["queued", "running"]),
            ),
        );
}

export async function setProvisionInitState(
    db: Database,
    id: string,
    initState: ClusterProvisionInitState,
) {
    await db.update(clusterProvisions).set({ initState }).where(eq(clusterProvisions.id, id));
}

/** Registers the new cluster and drops the single-use SSH key in one step. */
export async function completeProvision(
    db: Database,
    id: string,
    sidecarUrl: string,
    sidecarToken: string,
    sidecarCertificate: string | null,
) {
    return db.transaction(async (tx) => {
        const [provision] = await tx
            .select()
            .from(clusterProvisions)
            .where(eq(clusterProvisions.id, id))
            .for("update");

        if (!provision) throw new Error("The provisioning request was deleted.");

        const clusterId = randomUUID();
        await tx.insert(clusters).values({
            id: clusterId,
            name: provision.name,
            sidecarUrl,
            sidecarToken,
            sidecarCertificate,
            organizationId: provision.organizationId,
        });
        await tx
            .update(clusterProvisions)
            .set({ status: "ready", error: null, encryptedPrivateKey: null, clusterId })
            .where(eq(clusterProvisions.id, id));

        return clusterId;
    });
}

/** Queued requests for the worker outbox sweep. */
export async function queuedProvisions(db: Database) {
    const rows = await db
        .select({ id: clusterProvisions.id, requestedAt: clusterProvisions.requestedAt })
        .from(clusterProvisions)
        .where(
            and(eq(clusterProvisions.status, "queued"), isNotNull(clusterProvisions.requestedAt)),
        );

    return rows.flatMap(({ id, requestedAt }) => (requestedAt ? [{ id, requestedAt }] : []));
}
