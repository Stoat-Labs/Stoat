import type { Database } from "@stoat/db";
import { formatComposeFile } from "./compose";
import { ALLOY_SERVICE, GREPTIME_SERVICE } from "./monitoring-compose";

/** Cluster services Stoat runs itself; no resource deploy may ever remove them. */
const RESERVED_SERVICES = ["caddy", GREPTIME_SERVICE, ALLOY_SERVICE];

type Snapshot = { spec: string | null; prefix: string | null };

/** The deployed service names in a Compose snapshot, prefixed the way that deployment prefixed them. */
export function snapshotServices(snapshot: Snapshot | undefined) {
    if (!snapshot?.spec?.trim()) return [];

    try {
        return formatComposeFile(snapshot.spec, snapshot.prefix || undefined).serviceNames;
    } catch {
        // An unreadable snapshot cannot have been deployed, so it has nothing running.
        return [];
    }
}

/**
 * What a deploy should remove: services this resource ran before (its last snapshot, plus any
 * service still carrying its prefix) that the new Compose no longer has. A name another resource
 * runs, which happens with prefixes turned off, and Stoat's own services are never touched.
 */
export function staleServices(
    previous: Iterable<string>,
    next: Iterable<string>,
    ownedElsewhere: Iterable<string>,
) {
    const keep = new Set([...next, ...ownedElsewhere, ...RESERVED_SERVICES]);

    return [...new Set(previous)].filter((name) => !keep.has(name)).toSorted();
}

// Raw SQL: this package's drizzle-orm is the effect-mq v1 build, not the app's, so its operators
// must not be mixed with @stoat/db tables.

/** The latest successful deployment's snapshot for each resource on a cluster. */
async function latestSnapshots(db: Database, clusterId: string) {
    const { rows } = await db.$client.query<Snapshot & { resource_id: string }>(
        `SELECT DISTINCT ON (d.resource_id) d.resource_id, d.spec, i.prefix
         FROM deployments d
         JOIN resources r ON r.id = d.resource_id
         JOIN projects p ON p.id = r.project_id
         LEFT JOIN resource_deployment_inputs i ON i.deployment_id = d.id
         WHERE p.cluster_id = $1 AND d.name = 'DeployResource' AND d.status = 'ready'
         ORDER BY d.resource_id, d.finished_at DESC NULLS LAST, d.created_at DESC`,
        [clusterId],
    );

    return rows;
}

/**
 * Before a resource deploys: what it ran last time, and what every other resource on the cluster
 * runs, so a rename removes only this resource's old services.
 */
export async function deployedServiceNames(db: Database, clusterId: string, resourceId: string) {
    const snapshots = await latestSnapshots(db, clusterId);

    const own = snapshots.find((row) => row.resource_id === resourceId);

    return {
        // Without its recorded prefix the old names are a guess, and a guess must not delete anything.
        own: own?.prefix === null ? [] : snapshotServices(own),
        others: snapshots
            .filter((row) => row.resource_id !== resourceId)
            .flatMap((row) => snapshotServices(row)),
    };
}
