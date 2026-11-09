import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { clusters, projects } from "@stoat/db/schema/index";
import { and, eq, sql } from "drizzle-orm";

export async function assertProjectVisible(
    db: Pick<Database, "select">,
    organizationId: string,
    projectId: string,
) {
    const [project] = await db
        .select({ id: projects.id, clusterId: projects.clusterId })
        .from(projects)
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(and(eq(projects.id, projectId), eq(clusters.organizationId, organizationId)))
        .limit(1);

    if (!project) {
        throw new ORPCError("NOT_FOUND", { message: "Project not found." });
    }

    return project;
}

/** The project, as a subquery, when it belongs to the organization and is not system-managed. */
export function editableProject(
    db: Pick<Database, "select">,
    organizationId: string,
    projectId: string,
) {
    return db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                eq(projects.id, projectId),
                sql`${projects.isInternal} is not true`,
                eq(clusters.organizationId, organizationId),
            ),
        );
}
