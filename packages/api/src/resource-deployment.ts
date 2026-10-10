import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    deploymentLogs,
    deployments,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { ComposeVariableError } from "@stoat/workflows/compose";
import { checkVariableReferences } from "@stoat/workflows/references";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { formatComposeFile, resourceComposePrefix, resourceEnv } from "./compose";

type Transaction = Pick<Database, "select" | "insert">;

/**
 * Validates the saved draft and records a queued deployment of it. Call inside the transaction
 * that locked the resource row, then enqueue the returned id after it commits.
 */
export async function insertResourceDeployment(
    tx: Transaction,
    db: Database,
    resource: typeof resources.$inferSelect,
    clusterId: string,
    recreate: boolean,
): Promise<string> {
    const spec = resource.draftSpec;

    if (!spec?.trim())
        throw new ORPCError("BAD_REQUEST", { message: "Save a Compose spec before deploying." });

    if (Buffer.byteLength(spec) > 4 * 1024 * 1024)
        throw new ORPCError("BAD_REQUEST", { message: "Compose must not exceed 4 MiB." });

    const prefix = resourceComposePrefix(resource) ?? "";

    try {
        if (formatComposeFile(spec, prefix).serviceCount === 0)
            throw new Error("Compose must contain at least one service.");
    } catch {
        throw new ORPCError("BAD_REQUEST", {
            message: "Save a valid Compose spec containing at least one service before deploying.",
        });
    }

    // Fail fast on broken references; the worker resolves them again at deploy time.
    const env = resourceEnv(resource);

    try {
        await checkVariableReferences(db, clusterId, resource.id, spec, env);
    } catch (error) {
        if (!(error instanceof ComposeVariableError)) throw error;
        throw new ORPCError("BAD_REQUEST", { message: error.message });
    }

    const [active] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
            and(
                eq(deployments.resourceId, resource.id),
                inArray(deployments.status, ["queued", "running"]),
            ),
        )
        .limit(1);

    if (active)
        throw new ORPCError("CONFLICT", {
            message: "This resource already has an active deployment.",
        });

    const deploymentId = randomUUID();
    await tx.insert(deployments).values({
        id: deploymentId,
        jobId: deploymentId,
        clusterId,
        resourceId: resource.id,
        name: "DeployResource",
        status: "queued",
        spec,
    });
    await tx.insert(resourceDeploymentInputs).values({ deploymentId, prefix, env, recreate });
    await tx.insert(deploymentLogs).values({
        deploymentId,
        text: "Resource deployment queued. Saved Compose snapshot captured.",
        metadata: { level: "info" },
    });

    return deploymentId;
}
