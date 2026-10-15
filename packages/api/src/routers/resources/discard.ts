import { ORPCError } from "@orpc/server";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { organizationAdminProcedure } from "../..";
import { composeResourceTypes } from "../../databases";
import { removeResources } from "../../resource-removal";

export const resourceDiscardRouter = {
    /**
     * Railway's "Discard" on staged changes: each resource goes back to what it last deployed
     * with, and one that never deployed is removed. Done together, because one canvas edit can
     * span resources (a service moved out of a group changes both).
     */
    discardChanges: organizationAdminProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceIds: v.pipe(
                    v.array(v.pipe(v.string(), v.uuid())),
                    v.minLength(1),
                    v.maxLength(200),
                ),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [project] = await tx
                    .select({ clusterId: projects.clusterId })
                    .from(projects)
                    .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                    .where(
                        and(
                            eq(projects.id, input.projectId),
                            sql`${projects.isInternal} is not true`,
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .limit(1);

                if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found." });

                const rows = await tx
                    .select()
                    .from(resources)
                    .where(
                        and(
                            inArray(resources.id, input.resourceIds),
                            eq(resources.projectId, input.projectId),
                            inArray(resources.type, composeResourceTypes),
                        ),
                    )
                    .for("update");

                if (rows.length !== new Set(input.resourceIds).size)
                    throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                const drafts = rows.filter((row) => !row.spec?.trim());

                const live = rows.filter((row) => row.spec?.trim());

                // Never deployed, so nothing runs for it: discarding the change removes it.
                await removeResources(tx, project.clusterId, drafts);

                for (const row of live) {
                    const [last] = await tx
                        .select({
                            env: resourceDeploymentInputs.env,
                            prefix: resourceDeploymentInputs.prefix,
                        })
                        .from(deployments)
                        .innerJoin(
                            resourceDeploymentInputs,
                            eq(resourceDeploymentInputs.deploymentId, deployments.id),
                        )
                        .where(
                            and(
                                eq(deployments.resourceId, row.id),
                                eq(deployments.name, "DeployResource"),
                                eq(deployments.status, "ready"),
                            ),
                        )
                        .orderBy(
                            sql`${deployments.finishedAt} desc nulls last`,
                            desc(deployments.createdAt),
                        )
                        .limit(1);

                    // Deploys before inputs were recorded only know their Compose; keep the rest.
                    const settings = last
                        ? sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${last.env}::text, 'prefixNames', ${last.prefix !== ""}::boolean)`
                        : resources.settings;

                    await tx
                        .update(resources)
                        .set({ draftSpec: row.spec, settings })
                        .where(eq(resources.id, row.id));
                }

                return { restored: live.length, removed: drafts.length };
            }),
        ),
};
