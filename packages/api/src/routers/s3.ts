import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { projects, resources, s3Buckets, s3Connections } from "@stoat/db/schema/index";
import {
    hasS3ConnectionSecrets,
    resolveS3Connection,
    s3ConnectionInput,
    s3FailureMessage,
    testS3Connection,
    type S3ConnectionInput,
} from "@stoat/s3";
import { and, asc, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationAdminProcedure, organizationProcedure } from "..";

const id = v.pipe(v.string(), v.uuid());

const name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

const version = v.pipe(v.number(), v.integer(), v.minValue(1));

type Connection = typeof s3Connections.$inferSelect;

function publicConnection(connection: Connection) {
    return {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        endpoint: connection.endpoint,
        region: connection.region,
        forcePathStyle: connection.forcePathStyle,
        accountId: connection.providerAccountId,
        version: connection.version,
        lastTestedAt: connection.lastTestedAt,
        lastTestStatus: connection.lastTestStatus,
        lastTestError: connection.lastTestError,
        updatedAt: connection.updatedAt,
    };
}

async function getConnection(db: Database, organizationId: string, connectionId: string) {
    const [connection] = await db
        .select()
        .from(s3Connections)
        .where(
            and(
                eq(s3Connections.id, connectionId),
                eq(s3Connections.organizationId, organizationId),
            ),
        )
        .limit(1);

    if (!connection) throw new ORPCError("NOT_FOUND", { message: "S3 connection not found." });

    return connection;
}

function conflict() {
    return new ORPCError("CONFLICT", {
        message: "This connection changed. Reload before continuing.",
    });
}

// Stored secrets may only be reused against the same provider account, never redirected elsewhere.
function sameTarget(saved: Connection, input: S3ConnectionInput) {
    if (saved.provider !== input.provider) return false;

    return input.provider === "r2"
        ? saved.providerAccountId === input.accountId
        : saved.endpoint === input.endpoint;
}

// Columns for a draft: freshly resolved when secrets were entered, otherwise the saved ones.
async function draftColumns(
    input: S3ConnectionInput,
    organizationId: string,
    connectionId: string,
    saved: Connection | null,
) {
    if (hasS3ConnectionSecrets(input)) {
        try {
            return await resolveS3Connection(input, organizationId, connectionId);
        } catch (error) {
            throw new ORPCError("BAD_REQUEST", {
                message: s3FailureMessage(
                    error instanceof Error ? error : new Error("Unable to verify credentials."),
                ),
            });
        }
    }

    if (!saved || !sameTarget(saved, input))
        throw new ORPCError("BAD_REQUEST", {
            message: "Re-enter the credentials when changing the provider account or endpoint.",
        });

    return {
        provider: saved.provider,
        endpoint: saved.endpoint,
        region: input.provider === "generic" ? input.region : saved.region,
        forcePathStyle: input.provider === "generic" ? input.forcePathStyle : saved.forcePathStyle,
        encryptedCredentials: saved.encryptedCredentials,
        providerAccountId: saved.providerAccountId,
        encryptedApiToken: saved.encryptedApiToken,
    };
}

export const s3Router = {
    list: organizationProcedure.handler(async ({ context: { db, organizationId } }) => {
        const rows = await db
            .select({ connection: s3Connections, buckets: count(s3Buckets.resourceId) })
            .from(s3Connections)
            .leftJoin(s3Buckets, eq(s3Buckets.connectionId, s3Connections.id))
            .where(eq(s3Connections.organizationId, organizationId))
            .groupBy(s3Connections.id)
            .orderBy(asc(s3Connections.name));

        return rows.map((row) => ({ ...publicConnection(row.connection), buckets: row.buckets }));
    }),
    get: organizationProcedure
        .input(v.object({ connectionId: id }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const connection = await getConnection(db, organizationId, input.connectionId);

            const buckets = await db
                .select({
                    resourceId: s3Buckets.resourceId,
                    name: s3Buckets.name,
                    status: s3Buckets.status,
                    resourceName: resources.name,
                    projectId: projects.id,
                    projectName: projects.name,
                })
                .from(s3Buckets)
                .innerJoin(resources, eq(s3Buckets.resourceId, resources.id))
                .innerJoin(projects, eq(resources.projectId, projects.id))
                .where(eq(s3Buckets.connectionId, connection.id))
                .orderBy(asc(s3Buckets.name));

            return { ...publicConnection(connection), buckets };
        }),
    create: organizationAdminProcedure
        .input(v.object({ name, connection: s3ConnectionInput }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const connectionId = randomUUID();

            if (!hasS3ConnectionSecrets(input.connection))
                throw new ORPCError("BAD_REQUEST", { message: "Enter the credentials." });

            const columns = await draftColumns(
                input.connection,
                organizationId,
                connectionId,
                null,
            );

            const [connection] = await db
                .insert(s3Connections)
                .values({ ...columns, id: connectionId, organizationId, name: input.name })
                .onConflictDoNothing()
                .returning();

            if (!connection)
                throw new ORPCError("CONFLICT", {
                    message: "A connection with this name already exists.",
                });

            return publicConnection(connection);
        }),
    update: organizationAdminProcedure
        .input(v.object({ connectionId: id, version, name, connection: s3ConnectionInput }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            const saved = await getConnection(db, organizationId, input.connectionId);

            if (saved.version !== input.version) throw conflict();

            if (saved.provider !== input.connection.provider)
                throw new ORPCError("BAD_REQUEST", {
                    message: "A connection's provider cannot be changed.",
                });

            const columns = await draftColumns(input.connection, organizationId, saved.id, saved);

            const [duplicate] = await db
                .select({ id: s3Connections.id })
                .from(s3Connections)
                .where(
                    and(
                        eq(s3Connections.organizationId, organizationId),
                        eq(s3Connections.name, input.name),
                    ),
                );

            if (duplicate && duplicate.id !== saved.id)
                throw new ORPCError("CONFLICT", {
                    message: "A connection with this name already exists.",
                });

            const [updated] = await db
                .update(s3Connections)
                .set({
                    ...columns,
                    name: input.name,
                    lastTestedAt: null,
                    lastTestStatus: null,
                    lastTestError: null,
                    version: saved.version + 1,
                })
                .where(
                    and(
                        eq(s3Connections.id, saved.id),
                        eq(s3Connections.organizationId, organizationId),
                        eq(s3Connections.version, input.version),
                    ),
                )
                .returning();

            if (!updated) throw conflict();

            return publicConnection(updated);
        }),
    remove: organizationAdminProcedure
        .input(v.object({ connectionId: id, version }))
        .handler(async ({ context: { db, organizationId }, input }) => {
            await getConnection(db, organizationId, input.connectionId);

            const [buckets] = await db
                .select({ total: count() })
                .from(s3Buckets)
                .where(eq(s3Buckets.connectionId, input.connectionId));

            // Its credentials are needed to revoke the keys of buckets provisioned from it.
            if (buckets?.total)
                throw new ORPCError("CONFLICT", {
                    message: "Delete the buckets provisioned from this connection first.",
                });

            const deleted = await db
                .delete(s3Connections)
                .where(
                    and(
                        eq(s3Connections.id, input.connectionId),
                        eq(s3Connections.organizationId, organizationId),
                        eq(s3Connections.version, input.version),
                    ),
                )
                .returning({ id: s3Connections.id });

            if (!deleted.length) throw conflict();

            return { success: true };
        }),
    test: organizationAdminProcedure
        .input(
            v.object({
                connection: s3ConnectionInput,
                connectionId: v.optional(id),
                version: v.optional(version),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const saved = input.connectionId
                ? await getConnection(db, organizationId, input.connectionId)
                : null;

            if (saved && input.version !== saved.version) throw conflict();

            const connectionId = saved?.id ?? randomUUID();

            const columns = await draftColumns(
                input.connection,
                organizationId,
                connectionId,
                saved,
            );

            let error: string | null = null;

            try {
                await testS3Connection({ ...columns, id: connectionId, organizationId });
            } catch (cause) {
                error = s3FailureMessage(
                    cause instanceof Error ? cause : new Error("Unable to reach S3."),
                );
            }

            // A draft test must never become the saved connection's health result.
            if (
                saved &&
                columns.encryptedCredentials === saved.encryptedCredentials &&
                columns.region === saved.region &&
                columns.forcePathStyle === saved.forcePathStyle
            ) {
                await db
                    .update(s3Connections)
                    .set({
                        lastTestedAt: new Date(),
                        lastTestStatus: error ? "failure" : "success",
                        lastTestError: error,
                        updatedAt: saved.updatedAt,
                    })
                    .where(
                        and(
                            eq(s3Connections.id, saved.id),
                            eq(s3Connections.version, saved.version),
                        ),
                    );
            }

            return {
                success: !error,
                message: error ?? "Connected. The credentials can list buckets.",
            };
        }),
};
