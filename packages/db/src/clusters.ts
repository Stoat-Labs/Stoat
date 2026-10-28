import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "./index";
import { clusters, deployments, type ClusterProvisioning } from "./schema";

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

/** Marks the setup finished and deletes its single-use keys, together with the job's success. */
export async function finishProvisioning(db: Database, clusterId: string, deploymentId: string) {
    await db.transaction(async (tx) => {
        await tx
            .update(clusters)
            .set({ provisioning: null, provisioningSecrets: null })
            .where(eq(clusters.id, clusterId));
        await tx
            .update(deployments)
            .set({ status: "ready", error: null, finishedAt: new Date() })
            .where(eq(deployments.id, deploymentId));
    });
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
