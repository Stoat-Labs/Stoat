import { posix } from "node:path";
import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { resources } from "@stoat/db/schema/index";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
    organizationAdminProcedure,
    organizationProcedure,
    requireAuth,
    resourceMiddleware,
} from "../..";
import { formatComposeFile } from "../../compose";
import { gitBlobId, listGitFiles, pushGitFile, readGitFile, validateGitPath } from "../../git";
import { getGitConnection, gitFilePath, gitMessage, gitRevision, gitText } from "../connections";

export const gitSourceInput = v.object({
    connectionId: v.pipe(v.string(), v.uuid()),
    repositoryUrl: v.pipe(v.string(), v.maxLength(4096)),
    branch: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    path: gitFilePath,
});

export const resourceEditInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    expectedSpec: v.nullable(gitText),
    expectedSource: v.nullable(v.object({ ...gitSourceInput.entries, revision: gitRevision })),
};

const resourceEditSchema = v.object(resourceEditInput);

export function resolveComposePath(path: string, files: string[]): string {
    const directory = path === "." ? "" : validateGitPath(path.replace(/\/$/, ""));

    if (files.includes(directory)) return directory;
    const prefix = directory ? `${directory}/` : "";

    for (const filename of [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yml",
        "docker-compose.yaml",
    ]) {
        if (files.includes(`${prefix}${filename}`)) return `${prefix}${filename}`;
    }

    throw new ORPCError("NOT_FOUND", {
        message:
            "No Compose file found. Choose a file or a directory containing compose.yaml, compose.yml, docker-compose.yml, or docker-compose.yaml.",
    });
}

function validateCompose(spec: string) {
    try {
        formatComposeFile(spec, "");
    } catch (error) {
        throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "Invalid Compose file.",
        });
    }
}

export async function loadGitCompose(
    db: Database,
    organizationId: string,
    source: v.InferOutput<typeof gitSourceInput>,
) {
    const repo = await getGitConnection(
        db,
        organizationId,
        source.connectionId,
        source.repositoryUrl,
        source.branch,
    );

    const tree = await listGitFiles(repo);
    const path = resolveComposePath(source.path, tree.files);
    const watchPath = posix.dirname(path);
    const file = await readGitFile(repo, path, watchPath);
    validateCompose(file.content);

    return {
        draftSpec: file.content,
        gitConnectionId: source.connectionId,
        gitSource: {
            repositoryUrl: repo.url,
            branch: repo.branch,
            path,
            revision: file.revision,
            blob: file.blob,
            tree: file.tree,
            autoDeploy: false,
            watchPath,
        },
    };
}

// The Git source of a draft with changes that are not committed yet, if any.
export function unpushedGitSource(resource: typeof resources.$inferSelect) {
    const { gitConnectionId: connectionId, gitSource: source, draftSpec: content } = resource;

    if (!connectionId || !source || content === null) return null;

    if (gitBlobId(content, source.revision) === source.blob) return null;

    return { connectionId, source, content };
}

// Lock the row during network operations so a concurrent draft edit cannot be lost.
export async function lockedComposeResource(
    db: Pick<Database, "select">,
    input: v.InferOutput<typeof resourceEditSchema>,
) {
    const { resourceId, projectId } = input;

    const [resource] = await db
        .select()
        .from(resources)
        .where(and(eq(resources.id, resourceId), eq(resources.projectId, projectId)))
        .for("update");

    if (!resource) throw new ORPCError("NOT_FOUND", { message: "Compose resource not found." });
    assertComposeSnapshot(resource, input);

    return resource;
}

function assertComposeSnapshot(
    resource: typeof resources.$inferSelect,
    input: v.InferOutput<typeof resourceEditSchema>,
) {
    const { expectedSpec, expectedSource } = input;

    if (resource.draftSpec !== expectedSpec) {
        throw new ORPCError("CONFLICT", {
            message: "The saved draft changed. Reload the resource before replacing or pushing it.",
        });
    }

    if (
        resource.gitConnectionId !== (expectedSource?.connectionId ?? null) ||
        (resource.gitSource?.repositoryUrl ?? null) !== (expectedSource?.repositoryUrl ?? null) ||
        (resource.gitSource?.branch ?? null) !== (expectedSource?.branch ?? null) ||
        (resource.gitSource?.path ?? null) !== (expectedSource?.path ?? null) ||
        (resource.gitSource?.revision ?? null) !== (expectedSource?.revision ?? null)
    ) {
        throw new ORPCError("CONFLICT", {
            message:
                "The Git source changed. Reload the resource before saving or changing its source.",
        });
    }
}

export const resourceGitRouter = {
    setGitSource: organizationProcedure
        .input(v.object({ ...resourceEditInput, ...gitSourceInput.entries }))
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            assertComposeSnapshot(resource, input);
            const source = await loadGitCompose(db, organizationId, input);

            return db.transaction(async (tx) => {
                await lockedComposeResource(tx, input);

                const [updated] = await tx
                    .update(resources)
                    .set(source)
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return updated!;
            });
        }),
    pullGitSource: organizationProcedure
        .input(v.object(resourceEditInput))
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            assertComposeSnapshot(resource, input);

            if (!input.expectedSource)
                throw new ORPCError("BAD_REQUEST", { message: "This resource has no Git source." });
            const source = input.expectedSource;

            const repo = await getGitConnection(
                db,
                organizationId,
                source.connectionId,
                source.repositoryUrl,
                source.branch,
            );

            const file = await readGitFile(repo, source.path, resource.gitSource?.watchPath);
            validateCompose(file.content);

            return db.transaction(async (tx) => {
                const resource = await lockedComposeResource(tx, input);

                if (!resource.gitConnectionId || !resource.gitSource)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "This resource has no Git source.",
                    });

                const [updated] = await tx
                    .update(resources)
                    .set({
                        draftSpec: file.content,
                        gitSource: {
                            ...resource.gitSource,
                            revision: file.revision,
                            blob: file.blob,
                            tree: file.tree,
                        },
                    })
                    .where(eq(resources.id, resource.id))
                    .returning();

                return updated!;
            });
        }),
    detachGitSource: organizationProcedure
        .input(v.object(resourceEditInput))
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) =>
            db.transaction(async (tx) => {
                await lockedComposeResource(tx, input);

                const [updated] = await tx
                    .update(resources)
                    .set({ gitConnectionId: null, gitSource: null })
                    .where(eq(resources.id, input.resourceId))
                    .returning();

                return updated!;
            }),
        ),
    setGitWatch: organizationAdminProcedure
        .input(
            v.object({
                ...resourceEditInput,
                autoDeploy: v.boolean(),
                watchPath: v.pipe(v.string(), v.trim(), v.maxLength(4096)),
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            assertComposeSnapshot(resource, input);

            if (!input.expectedSource)
                throw new ORPCError("BAD_REQUEST", { message: "This resource has no Git source." });
            const source = input.expectedSource;
            const directory = input.watchPath.replace(/\/+$/, "");

            const watchPath =
                directory === "" || directory === "." ? "." : validateGitPath(directory);

            const repo = await getGitConnection(
                db,
                organizationId,
                source.connectionId,
                source.repositoryUrl,
                source.branch,
            );

            // The watched tree is recorded at the synced revision, so newer commits are pulled first.
            const file = await readGitFile(repo, source.path, watchPath);

            if (file.revision !== source.revision)
                throw new ORPCError("CONFLICT", {
                    message: "Git has newer commits. Pull from Git before changing auto-deploy.",
                });

            return db.transaction(async (tx) => {
                const resource = await lockedComposeResource(tx, input);

                if (!resource.gitConnectionId || !resource.gitSource)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "This resource has no Git source.",
                    });

                const [updated] = await tx
                    .update(resources)
                    .set({
                        gitSource: {
                            ...resource.gitSource,
                            autoDeploy: input.autoDeploy,
                            watchPath,
                            // Both are at the synced revision, checked above.
                            blob: file.blob,
                            tree: file.tree,
                        },
                    })
                    .where(eq(resources.id, resource.id))
                    .returning();

                return updated!;
            });
        }),
    pushGitSource: organizationAdminProcedure
        .use(requireAuth)
        .input(
            v.object({
                ...resourceEditInput,
                spec: gitText,
                expectedRevision: gitRevision,
                message: gitMessage,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, session, resource }, input }) => {
            assertComposeSnapshot(resource, input);

            if (!input.expectedSource)
                throw new ORPCError("BAD_REQUEST", { message: "This resource has no Git source." });
            validateCompose(input.spec);
            const source = input.expectedSource;

            if (source.revision !== input.expectedRevision)
                throw new ORPCError("CONFLICT", {
                    message: "The Git source changed. Reload the resource before pushing.",
                });

            const repo = await getGitConnection(
                db,
                organizationId,
                source.connectionId,
                source.repositoryUrl,
                source.branch,
            );

            return db.transaction(async (tx) => {
                const resource = await lockedComposeResource(tx, input);

                if (!resource.gitConnectionId || !resource.gitSource)
                    throw new ORPCError("BAD_REQUEST", {
                        message: "This resource has no Git source.",
                    });

                if (resource.gitSource.revision !== input.expectedRevision)
                    throw new ORPCError("CONFLICT", {
                        message: "The Git source changed. Reload the resource before pushing.",
                    });

                const result = await pushGitFile(repo, {
                    path: resource.gitSource.path,
                    content: input.spec,
                    expectedRevision: input.expectedRevision,
                    message: input.message,
                    author: { name: session.user.name, email: session.user.email },
                    watchPath: resource.gitSource.watchPath,
                });

                const [updated] = await tx
                    .update(resources)
                    .set({
                        draftSpec: input.spec,
                        gitSource: { ...resource.gitSource, ...result },
                    })
                    .where(eq(resources.id, resource.id))
                    .returning();

                return updated!;
            });
        }),
};
