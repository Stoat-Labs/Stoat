import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { clusters, projects, resources, type ResourceGitSource } from "@stoat/db/schema/index";
import { queueResourceDeployment } from "@stoat/workflows/runtime";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { readGitFile, readGitHead } from "./git";
import { insertResourceDeployment, readComposeConfigFiles } from "./resource-deployment";
import { getBoundGitRepository } from "./routers/connections";
import { unpushedGitSource } from "./routers/resources/git";

// Runs once per WatchGitSources tick. For every resource with auto-deploy on, it checks the
// branch head and, when a push changed the watched directory, pulls the Compose file and
// deploys it. Throwing fails this tick only; the next tick runs regardless.
export async function watchGitSources(db: Database, signal: AbortSignal) {
    const watched = await db
        .select({
            resource: resources,
            organizationId: clusters.organizationId,
            clusterId: projects.clusterId,
        })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                isNotNull(resources.gitConnectionId),
                sql`(${resources.gitSource}->>'autoDeploy')::boolean is true`,
                sql`${projects.isInternal} is not true`,
            ),
        );

    for (const { resource, organizationId, clusterId } of watched) {
        signal.throwIfAborted();

        try {
            const deploymentId = await syncResource(db, organizationId, clusterId, resource);

            // The deployment row is the durable outbox if enqueue is temporarily unavailable.
            if (deploymentId) await queueResourceDeployment(deploymentId).catch(() => {});
        } catch (error) {
            // One unreachable repository must not stop the others; the next tick retries it.
            signal.throwIfAborted();
            console.error(`Watching Git for resource ${resource.id} failed:`, error);
        }
    }
}

async function syncResource(
    db: Database,
    organizationId: string,
    clusterId: string,
    resource: typeof resources.$inferSelect,
): Promise<string | null> {
    const { gitConnectionId: connectionId, gitSource: source } = resource;

    if (!connectionId || !source) return null;

    const repo = await getBoundGitRepository(
        db,
        organizationId,
        connectionId,
        source.repositoryUrl,
        source.branch,
    );

    if ((await readGitHead(repo)) === source.revision) return null;

    const file = await readGitFile(repo, source.path, source.watchPath);
    const changed = file.blob !== source.blob || file.tree !== source.tree;
    let configFiles: Record<string, string> | null = {};

    if (changed) {
        try {
            configFiles = await readComposeConfigFiles(repo, source.path, file.content);
        } catch (error) {
            if (!(error instanceof ORPCError && error.code === "BAD_REQUEST")) throw error;
            configFiles = null;
        }
    }

    return db.transaction(async (tx) => {
        const [locked] = await tx
            .select()
            .from(resources)
            .where(eq(resources.id, resource.id))
            .for("update");

        // Skip when the source changed meanwhile, or when pulling would overwrite unpushed
        // draft edits. Those wait until the user deploys (which pushes) or pulls.
        if (
            !locked?.gitSource?.autoDeploy ||
            locked.gitConnectionId !== connectionId ||
            !sameSource(locked.gitSource, source) ||
            unpushedGitSource(locked)
        )
            return null;

        const gitSource = {
            ...locked.gitSource,
            revision: file.revision,
            blob: file.blob,
            tree: file.tree,
        };

        if (!changed) {
            await tx.update(resources).set({ gitSource }).where(eq(resources.id, resource.id));

            return null;
        }

        const [pulled] = await tx
            .update(resources)
            .set({ draftSpec: file.content, gitSource })
            .where(eq(resources.id, resource.id))
            .returning();

        // Like an invalid Compose file below: a config file that cannot be read stays undeployed.
        if (!configFiles) return null;

        try {
            return await insertResourceDeployment(tx, db, pulled!, clusterId, false, configFiles);
        } catch (error) {
            // An invalid Compose file stays pulled but undeployed, like a manual pull would.
            // Anything else (such as an active deployment) rolls back, so the next tick retries.
            if (error instanceof ORPCError && error.code === "BAD_REQUEST") return null;
            throw error;
        }
    });
}

function sameSource(left: ResourceGitSource, right: ResourceGitSource) {
    return (
        left.repositoryUrl === right.repositoryUrl &&
        left.branch === right.branch &&
        left.path === right.path &&
        left.watchPath === right.watchPath &&
        left.revision === right.revision
    );
}
