import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import {
    clusters,
    gitConnections,
    projects,
    resources,
    type ResourceGitSource,
} from "@stoat/db/schema/index";
import { queueResourceDeployment } from "@stoat/workflows/runtime";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { type GitFileSnapshot, readGitHead, readGitSources } from "./index";
import {
    deploymentSource,
    insertResourceDeployment,
    readComposeConfigFiles,
} from "../resources/deployment";
import { getBoundGitRepository } from "../routers/connections";
import { unpushedGitSource } from "../routers/resources/git";

type Watched = {
    resource: typeof resources.$inferSelect;
    organizationId: string;
    clusterId: string;
    provider: (typeof gitConnections.$inferSelect)["provider"];
};

// Runs once per WatchGitSources job: every minute for all connections, and right after a push
// webhook for that connection only. For every resource with auto-deploy on, it checks the branch
// head and, when a push changed the watched directory, pulls the Compose file and deploys it.
// Throwing fails this run only; the next one runs regardless.
export async function watchGitSources(db: Database, signal: AbortSignal, connectionId?: string) {
    const watched = await db
        .select({
            resource: resources,
            organizationId: clusters.organizationId,
            clusterId: projects.clusterId,
            provider: gitConnections.provider,
        })
        .from(resources)
        .innerJoin(gitConnections, eq(resources.gitConnectionId, gitConnections.id))
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .where(
            and(
                isNotNull(resources.gitConnectionId),
                connectionId ? eq(resources.gitConnectionId, connectionId) : undefined,
                sql`(${resources.gitSource}->>'autoDeploy')::boolean is true`,
                // A resource staged for deletion must not be redeployed behind the user's back.
                eq(resources.pendingDelete, false),
                sql`${projects.isInternal} is not true`,
            ),
        );

    // Resources on the same branch share one head check and one fetch, so a monorepo with many
    // Compose files costs the same as one.
    const groups = Map.groupBy(watched, ({ resource }) =>
        JSON.stringify([
            resource.gitConnectionId,
            resource.gitSource!.repositoryUrl,
            resource.gitSource!.branch,
        ]),
    );

    for (const group of groups.values()) {
        signal.throwIfAborted();

        try {
            await syncGroup(db, group, connectionId ? "webhook" : "poll");
        } catch (error) {
            // One unreachable repository must not stop the others; the next run retries it.
            signal.throwIfAborted();
            console.error("Watching Git failed:", error);
        }
    }
}

async function syncGroup(db: Database, group: Watched[], trigger: "webhook" | "poll") {
    const { resource, organizationId } = group[0]!;
    const source = resource.gitSource!;

    const repo = await getBoundGitRepository(
        db,
        organizationId,
        resource.gitConnectionId!,
        source.repositoryUrl,
        source.branch,
    );

    const head = await readGitHead(repo);
    const behind = group.filter((item) => item.resource.gitSource!.revision !== head);

    if (behind.length === 0) return;

    const files = await readGitSources(
        repo,
        behind.map((item) => item.resource.gitSource!),
    );

    for (const [index, item] of behind.entries()) {
        const file = files[index]!;

        try {
            if (file instanceof Error) throw file;

            const deploymentId = await syncResource(db, item, file, trigger, async (content) =>
                readComposeConfigFiles(repo, item.resource.gitSource!.path, content),
            );

            // The deployment row is the durable outbox if enqueue is temporarily unavailable.
            if (deploymentId) await queueResourceDeployment(deploymentId).catch(() => {});
        } catch (error) {
            console.error(`Watching Git for resource ${item.resource.id} failed:`, error);
        }
    }
}

async function syncResource(
    db: Database,
    { resource, clusterId, provider }: Watched,
    file: GitFileSnapshot,
    trigger: "webhook" | "poll",
    readConfigFiles: (content: string) => Promise<Record<string, string>>,
): Promise<string | null> {
    const { gitConnectionId: connectionId, gitSource: source } = resource;

    if (!connectionId || !source) return null;

    const changed = file.blob !== source.blob || file.tree !== source.tree;
    let configFiles: Record<string, string> | null = {};

    if (changed) {
        try {
            configFiles = await readConfigFiles(file.content);
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
            // Staged for deletion after the watch query above picked it up.
            locked.pendingDelete ||
            locked.gitConnectionId !== connectionId ||
            !sameSource(locked.gitSource, source) ||
            unpushedGitSource(locked)
        )
            return null;

        const gitSource = {
            ...locked.gitSource,
            revision: file.revision,
            message: file.message,
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
            return await insertResourceDeployment(
                tx,
                db,
                pulled!,
                clusterId,
                false,
                {
                    source: deploymentSource(provider),
                    trigger,
                    commit: { sha: file.revision, message: file.message },
                },
                configFiles,
            );
        } catch (error) {
            // An invalid Compose file stays pulled but undeployed, like a manual pull would.
            // Anything else (such as an active deployment) rolls back, so the next run retries.
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
