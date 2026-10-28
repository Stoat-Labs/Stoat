import { ORPCError } from "@orpc/server";
import { appSecret } from "@stoat/config/env";
import { clusterProvisionLogs, clusterProvisions } from "@stoat/db/schema/index";
import { generateProvisionKey } from "@stoat/workflows/secrets";
import { isAllowedServerAddress } from "@stoat/workflows/server-address";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import * as v from "valibot";
import { organizationAdminProcedure } from "../..";

const provisionInput = v.object({ provisionId: v.pipe(v.string(), v.uuid()) });

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

// The worker never needs more than this to show what happened.
const MAX_LOGS = 2000;

// Everything but the encrypted key, which never leaves the server.
const provisionColumns = {
    id: clusterProvisions.id,
    name: clusterProvisions.name,
    host: clusterProvisions.host,
    port: clusterProvisions.port,
    user: clusterProvisions.user,
    publicKey: clusterProvisions.publicKey,
    status: clusterProvisions.status,
    initState: clusterProvisions.initState,
    error: clusterProvisions.error,
    clusterId: clusterProvisions.clusterId,
    createdAt: clusterProvisions.createdAt,
    updatedAt: clusterProvisions.updatedAt,
};

export const provisionRouter = {
    // Unfinished requests; finished ones are their cluster.
    listProvisions: organizationAdminProcedure.handler(({ context: { db, organizationId } }) =>
        db
            .select(provisionColumns)
            .from(clusterProvisions)
            .where(
                and(
                    eq(clusterProvisions.organizationId, organizationId),
                    ne(clusterProvisions.status, "ready"),
                ),
            )
            .orderBy(asc(clusterProvisions.createdAt)),
    ),

    getProvision: organizationAdminProcedure
        .input(provisionInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [provision] = await db
                .select(provisionColumns)
                .from(clusterProvisions)
                .where(
                    and(
                        eq(clusterProvisions.id, input.provisionId),
                        eq(clusterProvisions.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!provision) throw new ORPCError("NOT_FOUND", { message: "Request not found." });

            const logs = await db
                .select({
                    id: clusterProvisionLogs.id,
                    text: clusterProvisionLogs.text,
                    level: clusterProvisionLogs.level,
                    createdAt: clusterProvisionLogs.createdAt,
                })
                .from(clusterProvisionLogs)
                .where(eq(clusterProvisionLogs.provisionId, provision.id))
                .orderBy(desc(clusterProvisionLogs.id))
                .limit(MAX_LOGS);

            // The newest lines hold the outcome, so those are the ones kept.
            return { ...provision, logs: logs.reverse() };
        }),

    createProvision: organizationAdminProcedure
        .input(
            v.object({
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                host: v.pipe(
                    v.string(),
                    v.trim(),
                    v.maxLength(253),
                    v.check(
                        (host) => isIP(host) !== 0 || HOSTNAME.test(host),
                        "Enter a hostname or IP address.",
                    ),
                ),
                port: v.optional(
                    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
                    22,
                ),
                user: v.optional(
                    v.pipe(
                        v.string(),
                        v.trim(),
                        v.maxLength(32),
                        v.regex(/^[a-z_][a-z0-9_.-]*$/i, "Enter a valid Linux user name."),
                    ),
                    "root",
                ),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            // The worker checks what a hostname resolves to before it connects.
            if (
                /^(.+\.)?localhost$/i.test(input.host) ||
                (isIP(input.host) && !isAllowedServerAddress(input.host))
            )
                throw new ORPCError("BAD_REQUEST", {
                    message: "Stoat doesn't connect to loopback, link-local or reserved addresses.",
                });

            const id = randomUUID();
            // The comment tells the user which authorized key to remove later.
            const key = generateProvisionKey(appSecret(), id, `stoat-${id.slice(0, 8)}`);

            await db.insert(clusterProvisions).values({
                id,
                organizationId,
                name: input.name,
                host: input.host,
                port: input.port,
                user: input.user,
                publicKey: key.publicKey,
                encryptedPrivateKey: key.encryptedPrivateKey,
            });

            return { id, publicKey: key.publicKey };
        }),

    // Starts or retries a request. The saved row is the outbox; the worker picks it up.
    startProvision: organizationAdminProcedure
        .input(
            v.object({
                provisionId: v.pipe(v.string(), v.uuid()),
                // Required after an attempt left a half-created cluster on the server.
                reset: v.optional(v.boolean(), false),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [provision] = await tx
                    .select({
                        id: clusterProvisions.id,
                        status: clusterProvisions.status,
                        initState: clusterProvisions.initState,
                    })
                    .from(clusterProvisions)
                    .where(
                        and(
                            eq(clusterProvisions.id, input.provisionId),
                            eq(clusterProvisions.organizationId, organizationId),
                        ),
                    )
                    .for("update");

                if (!provision) throw new ORPCError("NOT_FOUND", { message: "Request not found." });

                if (provision.status !== "pending" && provision.status !== "failed")
                    throw new ORPCError("CONFLICT", {
                        message: "This request is already running or finished.",
                    });

                if (provision.initState === "partial" && !input.reset)
                    throw new ORPCError("CONFLICT", {
                        message: "Confirm resetting the server to retry.",
                    });

                await tx
                    .delete(clusterProvisionLogs)
                    .where(eq(clusterProvisionLogs.provisionId, provision.id));

                const [started] = await tx
                    .update(clusterProvisions)
                    .set({
                        status: "queued",
                        error: null,
                        requestedAt: new Date(),
                        initState:
                            provision.initState === "partial" ? "reset" : provision.initState,
                    })
                    .where(eq(clusterProvisions.id, provision.id))
                    .returning({ id: clusterProvisions.id, status: clusterProvisions.status });

                return started!;
            }),
        ),

    deleteProvision: organizationAdminProcedure
        .input(provisionInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [deleted] = await db
                .delete(clusterProvisions)
                .where(
                    and(
                        eq(clusterProvisions.id, input.provisionId),
                        eq(clusterProvisions.organizationId, organizationId),
                        inArray(clusterProvisions.status, ["pending", "failed"]),
                    ),
                )
                .returning({ id: clusterProvisions.id });

            if (deleted) return deleted;

            const [existing] = await db
                .select({ id: clusterProvisions.id })
                .from(clusterProvisions)
                .where(
                    and(
                        eq(clusterProvisions.id, input.provisionId),
                        eq(clusterProvisions.organizationId, organizationId),
                    ),
                );

            if (!existing) throw new ORPCError("NOT_FOUND", { message: "Request not found." });

            throw new ORPCError("CONFLICT", {
                message: "Only waiting or failed requests can be deleted.",
            });
        }),
};
