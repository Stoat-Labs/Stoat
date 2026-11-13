import type { Database } from "@clowder/db";
import { finishProvisioning, setProvisioningInitState } from "@clowder/db/clusters";
import { appendDeploymentLog, setDeploymentStatus } from "@clowder/db/deployments";
import type { ClusterProvisioning } from "@clowder/db/schema/index";
import { ucClient } from "@clowder/uncloud";
import { access, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { generate } from "selfsigned";
import { stringify } from "yaml";
import sidecarCompose from "../../../internal/sidecar/compose.yaml?raw";
import { CLUSTER_STORAGE_CADDY, createCaddyDeployment } from "./deploy-caddy";
import { isPrivateServerAddress } from "./server-address";
import {
    createWorkspace,
    machineState,
    runUc,
    serverAddress,
    sshDestination,
    sshFailure,
    sshKeyPair,
    ucVersion,
    type Log,
    type Server,
    type Workspace,
} from "./ssh-setup";

// What `clusters.provisioning_secrets` holds until the cluster is ready.
type ProvisioningSecrets = { sshKey: string; tlsKey: string };

// The port the sidecar serves HTTPS on for Clowder, next to Uncloud's own 51xxx ports.
const SIDECAR_PORT = 51443;

const SIDECAR_READY_TIMEOUT = 2 * 60_000;

const ALREADY_MEMBER =
    "This server already belongs to an Uncloud cluster. Connect that cluster with its sidecar URL and token instead.";

/** The URL Clowder reaches the sidecar of a cluster it sets up on `host` at. */
export function provisionedSidecarUrl(host: string) {
    return `https://${isIP(host) === 6 ? `[${host}]` : host}:${SIDECAR_PORT}`;
}

/**
 * The single-use SSH key and the pinned sidecar certificate for a cluster Clowder sets up on
 * `host`. Everything private ends up in `secrets`, which is deleted once the cluster is ready.
 */
export async function provisioningCredentials(host: string, comment: string) {
    const ssh = sshKeyPair(comment);

    const tls = await generate([{ name: "commonName", value: host }], {
        keyType: "ec",
        algorithm: "sha256",
        // Pinned rather than trusted through a CA, so it only needs to outlast the cluster.
        notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000),
        extensions: [
            {
                name: "subjectAltName",
                altNames: [isIP(host) ? { type: 7, ip: host } : { type: 2, value: host }],
            },
        ],
    });

    const secrets: ProvisioningSecrets = { sshKey: ssh.privateKey, tlsKey: tls.private };

    return {
        publicKey: ssh.publicKey,
        certificate: tls.cert,
        secrets: JSON.stringify(secrets),
    };
}

/** The uc config `machine init` would have written, so later steps also work on a retry. */
export function clusterConfig(destination: string, keyPath: string) {
    return stringify({
        current_context: "default",
        contexts: { default: { connections: [{ ssh_go: destination, ssh_key_file: keyPath }] } },
    });
}

// Turns SSH, ownership and reachability errors into something the user can act on.
function initFailure(message: string, user: string) {
    if (message.includes("already initialised")) return ALREADY_MEMBER;

    return sshFailure(message, user);
}

async function initMachine(
    db: Database,
    clusterId: string,
    server: Server,
    initState: ClusterProvisioning["initState"],
    workspace: Workspace,
    log: Log,
    signal: AbortSignal,
) {
    if (initState === "partial")
        throw new Error(
            "An earlier attempt created a cluster on this server but didn't finish setting it up. Retry and confirm the reset to start over.",
        );

    // A confirmed reset targets the cluster Clowder's own earlier attempt created.
    if (initState === "none") {
        log(`Checking ${server.host} for an existing Uncloud cluster...`);

        const member = await machineState(server, workspace, signal).catch((error: Error) => {
            if (signal.aborted) throw error;

            throw new Error(initFailure(error.message, server.user));
        });

        if (member.id !== null) throw new Error(ALREADY_MEMBER);
    }

    const version = await ucVersion(workspace, signal);

    const args = [
        "machine",
        "init",
        `ssh+go://${sshDestination(server)}`,
        "--ssh-key",
        workspace.key,
    ];

    if (version) args.push("--version", version);

    // An uncld.dev domain needs the server reachable from the internet; Caddy still serves the LAN.
    if (isPrivateServerAddress(server.host)) args.push("--no-dns");

    // Only after the user confirmed resetting the cluster an earlier attempt left behind.
    if (initState === "reset") args.push("--yes");

    log(`Installing Uncloud ${version ?? "(latest)"} on ${server.host}...`);

    try {
        await runUc(workspace, args, log, signal);
    } catch (error) {
        // uc writes its config only once the cluster exists on the server.
        const created = await access(workspace.config).then(
            () => true,
            () => false,
        );

        // Pointing the apps' uncld.dev domain at the server is init's last step, and Clowder doesn't need it.
        if (
            created &&
            !signal.aborted &&
            error instanceof Error &&
            error.message.includes("no internet-reachable machines")
        ) {
            log(
                "Uncloud couldn't reach this server from the internet on port 80, so the cluster's uncld.dev domain doesn't point to it. Clowder doesn't need it; open ports 80 and 443 if your apps should use it.",
            );
            await setProvisioningInitState(db, clusterId, "done");

            return;
        }

        // Recorded before an abort is rethrown too, so the rerun doesn't refuse Clowder's own cluster.
        if (created) await setProvisioningInitState(db, clusterId, "partial");

        // An abort must stay an abort so the job is released, not failed.
        if (signal.aborted || !(error instanceof Error)) throw error;

        throw new Error(initFailure(error.message, server.user));
    }

    await setProvisioningInitState(db, clusterId, "done");
}

async function waitForSidecar(
    url: string,
    token: string,
    certificate: string | null,
    log: Log,
    signal: AbortSignal,
) {
    const uc = ucClient(url, { token, certificate });
    const deadline = Date.now() + SIDECAR_READY_TIMEOUT;

    log(`Waiting for ${url}...`);

    while (Date.now() < deadline) {
        signal.throwIfAborted();

        try {
            const { response } = await uc.GET("/readyz", {
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            });

            if (response.ok) return;
        } catch {
            // The container takes a moment to start listening; keep polling.
        }

        await delay(5_000, undefined, { signal });
    }

    throw new Error(
        `The sidecar at ${url} didn't respond in time. Check that port ${SIDECAR_PORT} is open to Clowder on the server.`,
    );
}

/** The advisory lock a setup attempt holds while it runs, so two never work on one server. */
export function provisioningLock(clusterId: string) {
    return `stoat:provision:${clusterId}`;
}

// Like Caddy's metrics for monitoring, this never fails setup: stock Caddy still serves the cluster.
async function deployClusterStorageCaddy(db: Database, clusterId: string, log: Log) {
    const { image, caddyfile } = CLUSTER_STORAGE_CADDY;

    try {
        await createCaddyDeployment(db, clusterId, image, caddyfile, false);
        log(`Deploying ${image} so every machine's Caddy shares certificates through the cluster.`);
    } catch {
        log("Couldn't switch Caddy to cluster storage. Change it in the cluster's Caddy settings.");
    }
}

/** Runs one setup attempt, the `ProvisionCluster` deployment `deploymentId`. */
export async function provisionCluster(db: Database, deploymentId: string, signal: AbortSignal) {
    const claimed = await db.$client.query<{ clusterId: string }>(
        `UPDATE deployments SET status = 'running', error = NULL, finished_at = NULL, updated_at = now()
         WHERE id = $1 AND name = 'ProvisionCluster' AND status IN ('queued', 'running')
         RETURNING cluster_id AS "clusterId"`,
        [deploymentId],
    );

    // Cancelled, settled or deleted since it was queued.
    const clusterId = claimed.rows[0]?.clusterId;

    if (!clusterId) return;

    // Lines are written in order without holding up uc's output.
    let pending = Promise.resolve();

    const log: Log = (text, level = "info") => {
        pending = pending.then(() =>
            appendDeploymentLog(db, deploymentId, text, { level }).catch(() => {}),
        );
    };

    const workspace = await createWorkspace("clowder-provision-");
    const lock = await db.$client.connect();
    let acquired = false;

    try {
        const result = await lock.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
            [provisioningLock(clusterId)],
        );

        acquired = result.rows[0]?.acquired === true;

        // A cancelled attempt keeps going until its worker's next heartbeat.
        if (!acquired)
            throw new Error("An earlier attempt is still stopping. Retry in a few seconds.");

        const cluster = await db.query.clusters.findFirst({
            where: { id: clusterId },
        });

        if (!cluster?.provisioning || !cluster.provisioningSecrets)
            throw new Error("This cluster is already set up.");

        // SAFETY: provisioningCredentials wrote this JSON, and the column is authenticated encryption.
        const secrets = JSON.parse(cluster.provisioningSecrets) as ProvisioningSecrets;
        const { initState } = cluster.provisioning;

        const server = {
            ...cluster.provisioning,
            host: await serverAddress(cluster.provisioning.host),
        };

        if (isPrivateServerAddress(server.host))
            log(`${server.host} is on a private network, so the cluster gets no public domain.`);

        await writeFile(workspace.key, secrets.sshKey, { mode: 0o600 });

        if (initState !== "done")
            await initMachine(db, clusterId, server, initState, workspace, log, signal);

        await writeFile(workspace.config, clusterConfig(sshDestination(server), workspace.key), {
            mode: 0o600,
        });

        const compose = join(workspace.dir, "compose.yaml");

        await writeFile(compose, sidecarCompose);
        log(`Deploying the Clowder sidecar to ${cluster.sidecarUrl}...`);
        await runUc(workspace, ["deploy", "--file", compose, "--yes"], log, signal, {
            SIDECAR_TOKEN: cluster.sidecarToken,
            SIDECAR_TLS_CERT: cluster.sidecarCertificate ?? "",
            SIDECAR_TLS_KEY: secrets.tlsKey,
        });
        await waitForSidecar(
            cluster.sidecarUrl,
            cluster.sidecarToken,
            cluster.sidecarCertificate,
            log,
            signal,
        );

        if (cluster.provisioning.caddyStorage) await deployClusterStorageCaddy(db, clusterId, log);

        log("Cluster is ready.");
        await pending;

        if (!(await finishProvisioning(db, clusterId, deploymentId)))
            log(
                "Setup was cancelled before Clowder saved the cluster. Retry to finish setting it up.",
            );
    } catch (error) {
        // Interruption is not a failure: the job is released and runs again.
        if (signal.aborted) throw error;

        const message = error instanceof Error ? error.message : "Setting up the cluster failed.";
        log(message, "error");
        await pending;
        await setDeploymentStatus(db, deploymentId, "failed", message);

        throw new Error(message);
    } finally {
        await pending;
        await rm(workspace.dir, { recursive: true, force: true });

        // Released last, so the next attempt only starts after this one's final writes.
        try {
            if (acquired)
                await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
                    provisioningLock(clusterId),
                ]);
        } finally {
            lock.release();
        }
    }
}
