import type { Database } from "@stoat/db";
import { finishProvisioning, setProvisioningInitState } from "@stoat/db/clusters";
import { appendDeploymentLog, setDeploymentStatus } from "@stoat/db/deployments";
import type { ClusterProvisioning } from "@stoat/db/schema/index";
import { ucClient } from "@stoat/uncloud";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { generate } from "selfsigned";
import { stringify } from "yaml";
import sidecarCompose from "../../../internal/sidecar/compose.yaml?raw";
import { CLUSTER_STORAGE_CADDY, createCaddyDeployment } from "./deploy-caddy";
import { isAllowedServerAddress, isPrivateServerAddress } from "./server-address";

type Log = (text: string, level?: "info" | "error") => void;

// The job's temp directory is also uc's HOME, so its config and SSH state never outlive the job.
type Workspace = { dir: string; config: string; key: string };

type Server = Pick<ClusterProvisioning, "host" | "port" | "user">;

// What `clusters.provisioning_secrets` holds until the cluster is ready.
type ProvisioningSecrets = { sshKey: string; tlsKey: string };

// The port the sidecar serves HTTPS on for Stoat, next to Uncloud's own 51xxx ports.
const SIDECAR_PORT = 51443;

const SIDECAR_READY_TIMEOUT = 2 * 60_000;

const ALREADY_MEMBER =
    "This server already belongs to an Uncloud cluster. Connect that cluster with its sidecar URL and token instead.";

// Docker reports every image layer's progress; the image's own Pulling and Pulled lines are enough.
const LAYER_PROGRESS = /^[0-9a-f]{12} on \S+ /;

/** The URL Stoat reaches the sidecar of a cluster it sets up on `host` at. */
export function provisionedSidecarUrl(host: string) {
    return `https://${isIP(host) === 6 ? `[${host}]` : host}:${SIDECAR_PORT}`;
}

// An SSH wire-format string: a 32-bit length, then the bytes.
function sshString(value: Buffer) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);

    return Buffer.concat([length, value]);
}

/**
 * The single-use SSH key and the pinned sidecar certificate for a cluster Stoat sets up on
 * `host`. Everything private ends up in `secrets`, which is deleted once the cluster is ready.
 */
export async function provisioningCredentials(host: string, comment: string) {
    const ssh = generateKeyPairSync("ed25519");
    const raw = ssh.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);

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

    const secrets: ProvisioningSecrets = {
        sshKey: ssh.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        tlsKey: tls.private,
    };

    return {
        publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
        certificate: tls.cert,
        secrets: JSON.stringify(secrets),
    };
}

/** `user@host:port`, with IPv6 hosts in brackets. */
export function sshDestination(server: Server) {
    const host = server.host.includes(":") ? `[${server.host}]` : server.host;

    return `${server.user}@${host}:${server.port}`;
}

/** The uc config `machine init` would have written, so later steps also work on a retry. */
export function clusterConfig(destination: string, keyPath: string) {
    return stringify({
        current_context: "default",
        contexts: { default: { connections: [{ ssh_go: destination, ssh_key_file: keyPath }] } },
    });
}

function runUc(
    workspace: Workspace,
    args: string[],
    log: Log,
    signal: AbortSignal,
    env: Record<string, string> = {},
) {
    return new Promise<string>((resolve, reject) => {
        // No app secrets, no SSH agent, and never UNCLOUD_AUTO_CONFIRM, which would let init reset a server.
        const child = spawn("uc", ["--uncloud-config", workspace.config, ...args], {
            env: { PATH: process.env.PATH ?? "", HOME: workspace.dir, ...env },
            stdio: ["ignore", "pipe", "pipe"],
            signal,
        });

        let stdout = "";
        let failure = "";
        let lastLine = "";

        // Progress output redraws lines with carriage returns; keep only the final state.
        const clean = (line: string) => stripVTControlCharacters(line).split("\r").at(-1)!.trim();

        createInterface({ input: child.stdout }).on("line", (line) => {
            const text = clean(line);
            stdout += `${text}\n`;

            if (!LAYER_PROGRESS.test(text)) log(text);
        });
        createInterface({ input: child.stderr }).on("line", (line) => {
            const text = clean(line);

            // uc reports the error that ended the command on an `Error:` line; the caller logs it.
            if (text.startsWith("Error: ")) {
                failure = text.slice("Error: ".length);

                return;
            }

            if (LAYER_PROGRESS.test(text)) return;

            if (text) lastLine = text;
            log(text);
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
            reject(
                error.code === "ENOENT"
                    ? new Error(
                          "The Uncloud CLI (uc) is not installed. Stoat's Docker image includes it; in development, put uc on your PATH.",
                      )
                    : error,
            );
        });
        child.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(failure || lastLine || `uc exited with code ${code}.`));
        });
    });
}

// Turns SSH, ownership and reachability errors into something the user can act on.
function initFailure(message: string, user: string) {
    if (message.includes("already initialised")) return ALREADY_MEMBER;

    if (message.includes("unable to authenticate") || message.includes("Permission denied"))
        return `The server rejected Stoat's key. Add the public key to ~/.ssh/authorized_keys for ${user}, then retry.`;

    // The key's temporary path means nothing to the user.
    return message.replace(/connect using private key "[^"]*": /, "");
}

/** The address to connect to: LAN, Tailscale and public servers yes, loopback and metadata never. */
async function serverAddress(host: string) {
    const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => []);

    if (!addresses.length) throw new Error(`Stoat couldn't resolve ${host}.`);

    if (addresses.some(({ address }) => !isAllowedServerAddress(address)))
        throw new Error(
            `Stoat doesn't connect to ${host}: it points to a loopback, link-local or reserved address.`,
        );

    // Connecting to the checked address means a DNS change can't redirect the job.
    return addresses[0]!.address;
}

/**
 * Whether the server already belongs to a cluster. `uc machine init` installs Uncloud before it
 * checks this, which restarts (or replaces) a member's daemon, so look first over plain SSH.
 */
function isClusterMember(server: Server, workspace: Workspace, signal: AbortSignal) {
    // Only root can read the machine state; a password prompt fails here and again, clearly, in uc.
    const sudo = server.user === "root" ? "" : "sudo -n ";

    // Host keys are not checked, like uc's own ssh+go connections.
    const options = [
        "BatchMode=yes",
        "IdentitiesOnly=yes",
        "ConnectTimeout=20",
        "StrictHostKeyChecking=no",
        "UserKnownHostsFile=/dev/null",
        "LogLevel=ERROR",
    ];

    const args = [
        "-F",
        "/dev/null",
        "-i",
        workspace.key,
        "-p",
        String(server.port),
        ...options.flatMap((option) => ["-o", option]),
        `${server.user}@${server.host}`,
        `${sudo}grep -qs '"ID": *"[^"]' /var/lib/uncloud/machine.json`,
    ];

    return new Promise<boolean>((resolve, reject) => {
        const child = spawn("ssh", args, {
            env: { PATH: process.env.PATH ?? "", HOME: workspace.dir },
            stdio: ["ignore", "ignore", "pipe"],
            signal,
        });

        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on("error", (error: NodeJS.ErrnoException) => {
            reject(
                error.code === "ENOENT"
                    ? new Error("OpenSSH (ssh) is not installed. Stoat's Docker image includes it.")
                    : error,
            );
        });
        // grep exits 0 on a match; ssh exits 255 when it can't log in.
        child.on("close", (code) => {
            if (code === 255) reject(new Error(stderr.trim() || "SSH login failed."));
            else resolve(code === 0);
        });
    });
}

/** The bundled uc's own version, so the daemon it installs always matches it. */
async function ucVersion(workspace: Workspace, signal: AbortSignal) {
    const output = await runUc(
        workspace,
        ["version", "--output", "{{.Version}}"],
        () => {},
        signal,
    );

    const version = output.trim();

    return /^v?\d+\.\d+\.\d+$/.test(version) ? version : null;
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

    // A confirmed reset targets the cluster Stoat's own earlier attempt created.
    if (initState === "none") {
        log(`Checking ${server.host} for an existing Uncloud cluster...`);

        const member = await isClusterMember(server, workspace, signal).catch((error: Error) => {
            if (signal.aborted) throw error;

            throw new Error(initFailure(error.message, server.user));
        });

        if (member) throw new Error(ALREADY_MEMBER);
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

        // Pointing the apps' uncld.dev domain at the server is init's last step, and Stoat doesn't need it.
        if (
            created &&
            !signal.aborted &&
            error instanceof Error &&
            error.message.includes("no internet-reachable machines")
        ) {
            log(
                "Uncloud couldn't reach this server from the internet on port 80, so the cluster's uncld.dev domain doesn't point to it. Stoat doesn't need it; open ports 80 and 443 if your apps should use it.",
            );
            await setProvisioningInitState(db, clusterId, "done");

            return;
        }

        // Recorded before an abort is rethrown too, so the rerun doesn't refuse Stoat's own cluster.
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
        `The sidecar at ${url} didn't respond in time. Check that port ${SIDECAR_PORT} is open to Stoat on the server.`,
    );
}

/** Runs one setup attempt, the `ProvisionCluster` deployment `deploymentId`. */
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

    const dir = await mkdtemp(join(tmpdir(), "stoat-provision-"));
    const workspace = { dir, config: join(dir, "config.yaml"), key: join(dir, "id_ed25519") };

    try {
        const cluster = await db.query.clusters.findFirst({
            where: (row, { eq }) => eq(row.id, clusterId),
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
        log(`Deploying the Stoat sidecar to ${cluster.sidecarUrl}...`);
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
                "Setup was cancelled before Stoat saved the cluster. Retry to finish setting it up.",
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
        await rm(dir, { recursive: true, force: true });
    }
}
