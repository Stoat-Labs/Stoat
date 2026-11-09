import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { resources } from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";

import { organizationProcedure, resourceMiddleware } from "../..";
import { composeConfigFiles } from "../../compose";
import { getBoundGitRepository } from "../connections";
import { readComposeConfigFiles } from "../../resources/deployment";
import {
    addVolume,
    attachVolume,
    ComposeVolumeError,
    detachVolume,
    nextVolumeName,
    remountVolume,
    removeVolume,
} from "../../compose/volumes";
import {
    addConfig,
    attachConfig,
    ComposeConfigError,
    detachConfig,
    nextConfigName,
    removeConfig,
    setConfigContent,
    updateConfigMount,
} from "../../compose/configs";

const volumeInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    volume: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
};

const newVolumeInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    // Left out, the volume is named after its service, like Railway's `redis-volume`.
    volume: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(63))),
};

const volumeMountInput = {
    service: v.pipe(v.string(), v.minLength(1)),
    target: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
};

const configInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    config: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
};

// A Git config file, by its `configs.*.file` path as written in Compose.
const configFileInput = {
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
    file: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
};

/** Rewrites a resource's Compose draft under a row lock, the way the other canvas edits do. */
function editComposeDraft(
    db: Pick<Database, "transaction">,
    resourceId: string,
    edit: (compose: string) => string,
) {
    return db.transaction(async (tx) => {
        const [resource] = await tx
            .select()
            .from(resources)
            .where(eq(resources.id, resourceId))
            .for("update");

        const compose = resource?.draftSpec?.trim() ? resource.draftSpec : resource?.spec;

        if (!resource || !compose?.trim())
            throw new ORPCError("BAD_REQUEST", {
                message: "Only Compose resources have volumes and configs.",
            });

        try {
            await tx
                .update(resources)
                .set({ draftSpec: edit(compose) })
                .where(eq(resources.id, resourceId));
        } catch (error) {
            if (error instanceof ComposeVolumeError || error instanceof ComposeConfigError)
                throw new ORPCError("BAD_REQUEST", { message: error.message });

            throw error;
        }

        return { id: resourceId };
    });
}

/** A `configs.*.file` of a Git-backed resource's draft, read from the branch head. */
async function readGitConfigFile(
    db: Database,
    organizationId: string,
    resource: typeof resources.$inferSelect,
    file: string,
) {
    const { gitSource: source, gitConnectionId: connectionId } = resource;
    const compose = resource.draftSpec ?? resource.spec ?? "";

    if (!source || !connectionId)
        throw new ORPCError("BAD_REQUEST", { message: "This resource has no Git source." });

    if (!composeConfigFiles(compose).includes(file))
        throw new ORPCError("NOT_FOUND", { message: `No config reads ${file}.` });

    const repo = await getBoundGitRepository(
        db,
        organizationId,
        connectionId,
        source.repositoryUrl,
        source.branch,
    );

    const contents = await readComposeConfigFiles(repo, source.path, compose);

    return contents[file] ?? "";
}

export const resourceMountsRouter = {
    // Volumes are Compose edits: they stage in the draft like any other change and ship on deploy.
    addVolume: organizationProcedure
        .input(v.object({ ...newVolumeInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) => {
            let volume = input.volume ?? "";

            await editComposeDraft(db, input.resourceId, (compose) => {
                volume ||= nextVolumeName(compose, input.service);

                return addVolume(compose, volume, input.service, input.target);
            });

            return { id: input.resourceId, volume };
        }),

    updateVolumeMount: organizationProcedure
        .input(
            v.object({
                ...volumeInput,
                ...volumeMountInput,
                // The path it is mounted at now, when the service mounts it at several.
                from: v.optional(v.pipe(v.string(), v.maxLength(512))),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                remountVolume(compose, input.volume, input.service, input.target, input.from),
            ),
        ),

    attachVolume: organizationProcedure
        .input(v.object({ ...volumeInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                attachVolume(compose, input.volume, input.service, input.target),
            ),
        ),

    detachVolume: organizationProcedure
        .input(v.object({ ...volumeInput, service: v.pipe(v.string(), v.minLength(1)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                detachVolume(compose, input.volume, input.service),
            ),
        ),

    deleteVolume: organizationProcedure
        .input(v.object(volumeInput))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                removeVolume(compose, input.volume),
            ),
        ),

    // Configs stage in the draft like volumes; new ones are inline `content:`, even with Git.
    addConfig: organizationProcedure
        .input(
            v.object({
                ...configInput,
                // Left out, the config is named after the file it mounts as.
                config: v.optional(configInput.config),
                ...volumeMountInput,
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db }, input }) => {
            let config = input.config ?? "";

            await editComposeDraft(db, input.resourceId, (compose) => {
                config ||= nextConfigName(compose, input.target);

                return addConfig(compose, config, input.service, input.target);
            });

            return { id: input.resourceId, config };
        }),

    attachConfig: organizationProcedure
        .input(v.object({ ...configInput, ...volumeMountInput }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                attachConfig(compose, input.config, input.service, input.target),
            ),
        ),

    updateConfigMount: organizationProcedure
        .input(
            v.object({
                ...configInput,
                ...volumeMountInput,
                // Octal, like 0444; empty leaves the container's default.
                mode: v.pipe(v.string(), v.maxLength(4)),
            }),
        )
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                updateConfigMount(compose, input.config, input.service, input.target, input.mode),
            ),
        ),

    detachConfig: organizationProcedure
        .input(v.object({ ...configInput, service: v.pipe(v.string(), v.minLength(1)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                detachConfig(compose, input.config, input.service),
            ),
        ),

    deleteConfig: organizationProcedure
        .input(v.object(configInput))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                removeConfig(compose, input.config),
            ),
        ),

    updateConfigContent: organizationProcedure
        .input(v.object({ ...configInput, content: v.pipe(v.string(), v.maxLength(1024 * 1024)) }))
        .use(resourceMiddleware)
        .handler(({ context: { db }, input }) =>
            editComposeDraft(db, input.resourceId, (compose) =>
                setConfigContent(compose, input.config, input.content),
            ),
        ),

    // A Git config file: its staged edit if there is one, and what the branch has.
    readConfigFile: organizationProcedure
        .input(v.object(configFileInput))
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            const original = await readGitConfigFile(db, organizationId, resource, input.file);
            const draft = resource.draftConfigFiles?.[input.file];

            return { content: draft ?? original, original, edited: draft !== undefined };
        }),

    // Stages an edit of a Git config file; the next deploy commits it with the Compose draft.
    // Content matching the branch, or null, drops the edit.
    updateConfigFile: organizationProcedure
        .input(
            v.object({
                ...configFileInput,
                content: v.nullable(v.pipe(v.string(), v.maxLength(1024 * 1024))),
            }),
        )
        .use(resourceMiddleware)
        .handler(async ({ context: { db, organizationId, resource }, input }) => {
            // Read before the row lock: it fetches the branch.
            const original = await readGitConfigFile(db, organizationId, resource, input.file);

            return db.transaction(async (tx) => {
                const [locked] = await tx
                    .select()
                    .from(resources)
                    .where(eq(resources.id, resource.id))
                    .for("update");

                // `original` was read from the source and Compose before the lock; both must still hold.
                if (
                    !locked?.gitSource ||
                    locked.gitConnectionId !== resource.gitConnectionId ||
                    !isDeepStrictEqual(locked.gitSource, resource.gitSource) ||
                    !composeConfigFiles(locked.draftSpec ?? locked.spec ?? "").includes(input.file)
                )
                    throw new ORPCError("CONFLICT", {
                        message: "The Git source changed. Reload the resource.",
                    });

                const { [input.file]: _previous, ...rest } = locked.draftConfigFiles ?? {};

                const files =
                    input.content === null || input.content === original
                        ? rest
                        : { ...rest, [input.file]: input.content };

                await tx
                    .update(resources)
                    .set({ draftConfigFiles: Object.keys(files).length ? files : null })
                    .where(eq(resources.id, resource.id));

                return { id: resource.id };
            });
        }),
};
