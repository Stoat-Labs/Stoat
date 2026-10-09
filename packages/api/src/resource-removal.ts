import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { ucClient } from "@stoat/uncloud";
import { resourceComposePrefix, resourceEnv } from "@stoat/workflows/compose";
import { referencedResourceIds } from "@stoat/workflows/references";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { formatComposeFile } from "./compose";

type Resource = typeof resources.$inferSelect;

type Transaction = Pick<Database, "select" | "delete">;

/** The services a resource last put on the cluster, or none if it never deployed. */
async function deployedServices(tx: Transaction, resource: Resource) {
    const [snapshot] = await tx
        .select({ spec: deployments.spec, prefix: resourceDeploymentInputs.prefix })
        .from(deployments)
        .leftJoin(resourceDeploymentInputs, eq(resourceDeploymentInputs.deploymentId, deployments.id))
        .where(
            and(
                eq(deployments.resourceId, resource.id),
                eq(deployments.name, "DeployResource"),
                eq(deployments.status, "ready"),
            ),
        )
        .orderBy(desc(deployments.finishedAt), desc(deployments.createdAt))
        .limit(1);

    const spec = snapshot?.spec ?? (resource.spec?.trim() ? resource.spec : null);

    if (!spec) return [];

    return formatComposeFile(spec, snapshot?.prefix ?? resourceComposePrefix(resource))
        .serviceNames;
}

/**
 * Deletes compose resources of one cluster, after removing their services from it. Refuses
 * while a resource is still deploying, is a bucket (those revoke provider keys through their
 * own flow), or is referenced by a resource that stays. Volumes are left on the machines, so
 * data is never destroyed as a side effect. Callers lock the rows and run this in a transaction;
 * a failed removal leaves the rows, and a retry skips services that are already gone.
 */
export async function removeResources(tx: Transaction, clusterId: string, removed: Resource[]) {
    if (!removed.length) return;
    const ids = removed.map((resource) => resource.id);
    const names = new Map(removed.map((resource) => [resource.id, resource.name]));

    const bucket = removed.find((resource) => resource.type === "bucket");

    if (bucket)
        throw new ORPCError("CONFLICT", {
            message: `Delete the S3 bucket "${bucket.name}" from its settings first.`,
        });

    const [active] = await tx
        .select({ resourceId: deployments.resourceId })
        .from(deployments)
        .where(
            and(
                inArray(deployments.resourceId, ids),
                inArray(deployments.status, ["queued", "running"]),
            ),
        )
        .limit(1);

    if (active)
        throw new ORPCError("CONFLICT", {
            message: `"${names.get(active.resourceId!)}" is deploying. Cancel or wait for the deployment first.`,
        });

    // Every other resource on the cluster that would be left with a dangling reference.
    const others = await tx
        .select({ name: resources.name, settings: resources.settings })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .where(
            and(
                eq(projects.clusterId, clusterId),
                notInArray(resources.id, ids),
                sql`${projects.isInternal} is not true`,
            ),
        );

    for (const other of others) {
        const target = referencedResourceIds(resourceEnv(other)).find((id) => names.has(id));

        if (target)
            throw new ORPCError("CONFLICT", {
                message: `"${other.name}" still references "${names.get(target)}". Remove the reference from its variables first.`,
            });
    }

    const [cluster] = await tx
        .select({ sidecarUrl: clusters.sidecarUrl, sidecarToken: clusters.sidecarToken })
        .from(clusters)
        .where(eq(clusters.id, clusterId))
        .limit(1);

    const uc = ucClient(cluster!.sidecarUrl, { token: cluster!.sidecarToken });

    for (const resource of removed) {
        for (const service of await deployedServices(tx, resource)) {
            const result = await uc
                .DELETE("/api/v1/services/{id}", {
                    params: { path: { id: service } },
                    signal: AbortSignal.timeout(30_000),
                })
                .catch(() => null);

            // Already gone is what we wanted.
            if (result && (result.response.ok || result.response.status === 404)) continue;

            const reason =
                result?.error?.error ?? "the sidecar did not respond";

            throw new ORPCError("BAD_GATEWAY", {
                message: `Could not remove service "${service}" from the cluster: ${reason}`,
            });
        }
    }

    await tx.delete(resources).where(inArray(resources.id, ids));
}
