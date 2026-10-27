import { eq, sql } from "drizzle-orm";
import type { Database } from "./index";
import { clusters } from "./schema";

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
