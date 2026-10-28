import { ORPCError } from "@orpc/server";
import { latestProvisioningDeployments } from "@stoat/db/clusters";
import { getDeploymentWithLogs } from "@stoat/db/deployments";
import { clusters, deployments, type ClusterProvisioning } from "@stoat/db/schema/index";
import { provisionedSidecarUrl, provisioningCredentials } from "@stoat/workflows/provision-cluster";
import { isAllowedServerAddress } from "@stoat/workflows/server-address";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import * as v from "valibot";
import { organizationAdminProcedure } from "../..";

const clusterInput = v.object({ clusterId: v.pipe(v.string(), v.uuid()) });

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/** Where a cluster Stoat creates over SSH is: waiting for its key, or its latest setup attempt. */
export function provisioningStatus(
    provisioning: ClusterProvisioning | null,
    attempt: string | undefined,
) {
    if (!provisioning) return "ready" as const;

    if (!attempt) return "pending" as const;

    if (attempt === "queued") return "queued" as const;

    if (attempt === "running") return "running" as const;

    // Failed and cancelled attempts are retried the same way.
    return "failed" as const;
}

export type ProvisioningStatus = ReturnType<typeof provisioningStatus>;

export const provisioningRouter = {
    // The cluster exists from the start; each setup attempt is a ProvisionCluster deployment of it.
    provisionCluster: organizationAdminProcedure
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
                caddyStorage: v.optional(v.boolean(), false),
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

            const credentials = await provisioningCredentials(
                input.host,
                `stoat-${id.slice(0, 8)}`,
            );

            await db.insert(clusters).values({
                id,
                organizationId,
                name: input.name,
                sidecarUrl: provisionedSidecarUrl(input.host),
                sidecarToken: randomBytes(32).toString("hex"),
                sidecarCertificate: credentials.certificate,
                provisioning: {
                    host: input.host,
                    port: input.port,
                    user: input.user,
                    publicKey: credentials.publicKey,
                    initState: "none",
                    caddyStorage: input.caddyStorage,
                },
                provisioningSecrets: credentials.secrets,
            });

            return { id, publicKey: credentials.publicKey };
        }),

    // The setup dialog: what to authorize, where setup is, and the latest attempt's logs.
    getProvisioning: organizationAdminProcedure
        .input(clusterInput)
        .handler(async ({ context: { db, organizationId }, input }) => {
            const [cluster] = await db
                .select({
                    id: clusters.id,
                    name: clusters.name,
                    provisioning: clusters.provisioning,
                })
                .from(clusters)
                .where(
                    and(
                        eq(clusters.id, input.clusterId),
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            const attempt = cluster
                ? (await latestProvisioningDeployments(db, [cluster.id])).get(cluster.id)
                : undefined;

            // A cluster connected by URL and token was never set up by Stoat.
            if (!cluster || (!cluster.provisioning && !attempt))
                throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

            const logs = attempt ? ((await getDeploymentWithLogs(db, attempt.id))?.logs ?? []) : [];

            return {
                id: cluster.id,
                name: cluster.name,
                setup: cluster.provisioning,
                status: provisioningStatus(cluster.provisioning, attempt?.status),
                error: attempt?.error ?? null,
                logs: logs.map((line) => ({
                    id: line.id,
                    text: line.text,
                    level: line.metadata.level === "error" ? ("error" as const) : ("info" as const),
                })),
            };
        }),

    // Starts or retries setup. The queued deployment is the outbox; the worker picks it up.
    startProvisioning: organizationAdminProcedure
        .input(
            v.object({
                clusterId: v.pipe(v.string(), v.uuid()),
                // Required after an attempt left a half-created cluster on the server.
                reset: v.optional(v.boolean(), false),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) =>
            db.transaction(async (tx) => {
                const [cluster] = await tx
                    .select({ id: clusters.id, provisioning: clusters.provisioning })
                    .from(clusters)
                    .where(
                        and(
                            eq(clusters.id, input.clusterId),
                            eq(clusters.organizationId, organizationId),
                        ),
                    )
                    .for("update");

                if (!cluster) throw new ORPCError("NOT_FOUND", { message: "Cluster not found." });

                if (!cluster.provisioning)
                    throw new ORPCError("CONFLICT", { message: "This cluster is already set up." });

                const [active] = await tx
                    .select({ id: deployments.id })
                    .from(deployments)
                    .where(
                        and(
                            eq(deployments.clusterId, cluster.id),
                            eq(deployments.name, "ProvisionCluster"),
                            inArray(deployments.status, ["queued", "running"]),
                        ),
                    )
                    .limit(1);

                if (active)
                    throw new ORPCError("CONFLICT", { message: "Setup is already running." });

                if (cluster.provisioning.initState === "partial") {
                    if (!input.reset)
                        throw new ORPCError("CONFLICT", {
                            message: "Confirm resetting the server to retry.",
                        });

                    await tx
                        .update(clusters)
                        .set({
                            provisioning: sql`jsonb_set(${clusters.provisioning}, '{initState}', '"reset"')`,
                        })
                        .where(eq(clusters.id, cluster.id));
                }

                const deploymentId = randomUUID();

                await tx.insert(deployments).values({
                    id: deploymentId,
                    jobId: deploymentId,
                    clusterId: cluster.id,
                    name: "ProvisionCluster",
                    status: "queued",
                });

                return { deploymentId };
            }),
        ),
};
