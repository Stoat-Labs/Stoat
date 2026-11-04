import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "./index";
import { clusters, deployments, type ClusterProvisioning, type PendingMachine } from "./schema";

/**
 * Rewrites sidecar tokens stored before they were encrypted. Reading decrypts them (plaintext
 * passes through), and writing them back encrypts, so this is safe to run on every start.
 */
export async function encryptLegacySidecarTokens(db: Database) {
    const legacy = await db
        .select({ id: clusters.id, sidecarToken: clusters.sidecarToken })
        .from(clusters)
        // Raw SQL: a column comparison would run the pattern through the column's encryption.
        .where(sql`${clusters.sidecarToken} not like 'enc:v1:%'`);

    for (const cluster of legacy)
        await db
            .update(clusters)
            .set({ sidecarToken: cluster.sidecarToken })
            .where(eq(clusters.id, cluster.id));

    return legacy.length;
}

/** Saves how far `uc machine init` got on a cluster Stoat is setting up. */
export async function setProvisioningInitState(
    db: Database,
    clusterId: string,
    initState: ClusterProvisioning["initState"],
) {
    await db
        .update(clusters)
        .set({
            provisioning: sql`jsonb_set(${clusters.provisioning}, '{initState}', to_jsonb(${initState}::text))`,
        })
        .where(and(eq(clusters.id, clusterId), isNotNull(clusters.provisioning)));
}

/**
 * Marks the setup finished and deletes its single-use keys, together with the job's success.
 * False when the job was cancelled meanwhile, which keeps the keys so the setup can be retried.
 */
export async function finishProvisioning(db: Database, clusterId: string, deploymentId: string) {
    return db.transaction(async (tx) => {
        // Takes the row lock, so a cancellation either lands first and is kept, or finds it finished.
        const [finished] = await tx
            .update(deployments)
            .set({ status: "ready", error: null, finishedAt: new Date() })
            .where(and(eq(deployments.id, deploymentId), eq(deployments.status, "running")))
            .returning({ id: deployments.id });

        if (!finished) return false;

        await tx
            .update(clusters)
            .set({ provisioning: null, provisioningSecrets: null })
            .where(eq(clusters.id, clusterId));

        return true;
    });
}

/** Records that the pending machine joined, so a retry only finishes spreading services to it. */
export async function setPendingMachineJoined(
    db: Database,
    clusterId: string,
    joined: NonNullable<PendingMachine["joined"]>,
) {
    await db
        .update(clusters)
        .set({
            pendingMachine: sql`jsonb_set(${clusters.pendingMachine}, '{joined}', ${JSON.stringify(joined)}::jsonb)`,
        })
        .where(and(eq(clusters.id, clusterId), isNotNull(clusters.pendingMachine)));
}

/** Records that an attempt runs uc on the pending server, so a retry knows a member it finds is its own. */
export async function markPendingMachineJoining(db: Database, clusterId: string) {
    await db
        .update(clusters)
        .set({
            pendingMachine: sql`jsonb_set(${clusters.pendingMachine}, '{joining}', 'true'::jsonb)`,
        })
        .where(and(eq(clusters.id, clusterId), isNotNull(clusters.pendingMachine)));
}

/** Forgets that the pending machine joined once it is removed, so a retry adds it again. */
export async function forgetJoinedMachine(
    db: Pick<Database, "update">,
    clusterId: string,
    machineId: string,
) {
    await db
        .update(clusters)
        .set({
            pendingMachine: sql`jsonb_set(${clusters.pendingMachine}, '{joined}', 'null'::jsonb)`,
        })
        .where(
            and(
                eq(clusters.id, clusterId),
                sql`${clusters.pendingMachine}->'joined'->>'id' = ${machineId}`,
            ),
        );
}

/** Marks the machine added and deletes its key with the job's success; false if it was cancelled meanwhile. */
export async function finishAddingMachine(db: Database, clusterId: string, deploymentId: string) {
    return db.transaction(async (tx) => {
        // Takes the row lock, so a cancellation either lands first and is kept, or finds it finished.
        const [finished] = await tx
            .update(deployments)
            .set({ status: "ready", error: null, finishedAt: new Date() })
            .where(and(eq(deployments.id, deploymentId), eq(deployments.status, "running")))
            .returning({ id: deployments.id });

        if (!finished) return false;

        await tx
            .update(clusters)
            .set({ pendingMachine: null, pendingMachineKey: null })
            .where(eq(clusters.id, clusterId));

        return true;
    });
}

/** The latest attempt to add the cluster's pending machine, prepared at `preparedAt`. */
export async function latestMachineAttempt(db: Database, clusterId: string, preparedAt: string) {
    const [row] = await db
        .select()
        .from(deployments)
        .where(
            and(
                eq(deployments.clusterId, clusterId),
                eq(deployments.name, "AddMachine"),
                gte(deployments.createdAt, new Date(preparedAt)),
            ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(1);

    return row ?? null;
}

/** The latest setup job of each cluster, for clusters Stoat creates over SSH. */
export async function latestProvisioningDeployments(db: Database, clusterIds: string[]) {
    if (!clusterIds.length) return new Map<string, typeof deployments.$inferSelect>();

    const rows = await db
        .selectDistinctOn([deployments.clusterId])
        .from(deployments)
        .where(
            and(
                inArray(deployments.clusterId, clusterIds),
                eq(deployments.name, "ProvisionCluster"),
            ),
        )
        .orderBy(deployments.clusterId, desc(deployments.createdAt));

    return new Map(rows.map((row) => [row.clusterId, row]));
}
