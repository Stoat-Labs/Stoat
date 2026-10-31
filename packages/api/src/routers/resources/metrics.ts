import { ORPCError } from "@orpc/server";
import { projects, resources } from "@stoat/db/schema/index";
import { resourceSlug } from "@stoat/db/slug";
import {
    ComposeVariableError,
    interpolateCompose,
    resourceComposePrefix,
    resourceEnv,
} from "@stoat/workflows/compose";
import {
    referencedResourceIds,
    referenceKeys,
    referenceTargets,
    resolveReferences,
} from "@stoat/workflows/references";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationProcedure, resourceMiddleware } from "../..";
import { databaseExporter } from "../../database-metrics";
import { databaseExporterEngine, type MetricsEngine } from "../../observability";
import { composeServices } from "../../project-graph";

/** Whether `row` already runs an `engine` exporter pointed at `resourceId`, deployed or not. */
function exportsFrom(
    row: Pick<typeof resources.$inferSelect, "settings" | "spec" | "draftSpec">,
    resourceId: string,
    engine: MetricsEngine,
) {
    try {
        return (
            referencedResourceIds(resourceEnv(row)).includes(resourceId) &&
            composeServices(row.draftSpec?.trim() ? row.draftSpec : (row.spec ?? "")).some(
                ({ image }) => image !== undefined && databaseExporterEngine(image) === engine,
            )
        );
    } catch {
        // Unreadable Variables or Compose can't be an exporter we'd duplicate.
        return false;
    }
}

export const resourceMetricsRouter = {
    /** Adds a draft exporter resource for a PostgreSQL, MySQL or MariaDB resource. */
    addDatabaseMetrics: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                resourceId: v.pipe(v.string(), v.uuid()),
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db, resource } }) => {
            const [project] = await db
                .select({ clusterId: projects.clusterId })
                .from(projects)
                .where(eq(projects.id, resource.projectId));

            const [target] = project
                ? await referenceTargets(db, project.clusterId, [resource.id])
                : [];

            if (!target) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

            let exporter: ReturnType<typeof databaseExporter>;

            try {
                // Resolved like a deploy, so `image: ${DB_IMAGE:-mariadb:13}` is recognized.
                exporter = databaseExporter(
                    interpolateCompose(
                        target.draftSpec ?? target.spec,
                        resourceEnv(target),
                        resourceComposePrefix(target),
                        "stoat-domain.invalid",
                    ),
                    referenceKeys(target).map(({ key }) => key),
                    resource.id,
                );
            } catch {
                throw new ORPCError("BAD_REQUEST", {
                    message: "The resource's Compose file can't be read.",
                });
            }

            if ("error" in exporter)
                throw new ORPCError("BAD_REQUEST", { message: exporter.error });

            const siblings = await db
                .select({
                    name: resources.name,
                    settings: resources.settings,
                    spec: resources.spec,
                    draftSpec: resources.draftSpec,
                })
                .from(resources)
                .where(eq(resources.projectId, resource.projectId));

            const existing = siblings.find((row) => exportsFrom(row, resource.id, exporter.engine));

            if (existing)
                throw new ORPCError("CONFLICT", {
                    message: `"${existing.name}" already exports this database's metrics.`,
                });

            // Fail here rather than at deploy, e.g. when the password is itself a reference.
            try {
                resolveReferences(exporter.env, [target], "stoat-domain.invalid");
            } catch (error) {
                if (!(error instanceof ComposeVariableError)) throw error;

                throw new ORPCError("BAD_REQUEST", { message: error.message });
            }

            const name = `${resource.name} metrics`.slice(0, 100);

            const [created] = await db
                .insert(resources)
                .values({
                    id: randomUUID(),
                    name,
                    slug: resourceSlug(name),
                    type: "compose",
                    projectId: resource.projectId,
                    draftSpec: exporter.compose,
                    settings: { prefixNames: true, env: exporter.env },
                })
                .returning();

            return created!;
        }),
};
