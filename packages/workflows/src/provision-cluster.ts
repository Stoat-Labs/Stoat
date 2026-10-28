import type { Database } from "@stoat/db";
import {
    appendProvisionLog,
    completeProvision,
    getProvision,
    setProvisionInitState,
    setProvisionStatus,
    type ClusterProvision,
} from "@stoat/db/provisions";
import { ucClient } from "@stoat/uncloud";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { decryptProvisionKey } from "./secrets";
import { isAllowedServerAddress, isPrivateServerAddress } from "./server-address";

type Log = (text: string, level?: "info" | "error") => void;

// The job's temp directory is also uc's HOME, so its config and SSH state never outlive the job.
type Workspace = { dir: string; config: string; key: string };

// The port the sidecar serves HTTPS on for Stoat, next to Uncloud's own 51xxx ports.
const SIDECAR_PORT = 51443;

const SIDECAR_READY_TIMEOUT = 2 * 60_000;

const ALREADY_MEMBER =
    "This server already belongs to an Uncloud cluster. Connect that cluster with its sidecar URL and token instead.";

// Docker reports every image layer's progress; the image's own Pulling and Pulled lines are enough.
const LAYER_PROGRESS = /^[0-9a-f]{12} on \S+ /;

/** `user@host:port`, with IPv6 hosts in brackets. */
export function sshDestination(provision: Pick<ClusterProvision, "user" | "host" | "port">) {
    const host = provision.host.includes(":") ? `[${provision.host}]` : provision.host;

    return `${provision.user}@${host}:${provision.port}`;
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
function isClusterMember(server: ClusterProvision, workspace: Workspace, signal: AbortSignal) {
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
    provision: ClusterProvision,
    workspace: Workspace,
    lan: boolean,
    log: Log,
    signal: AbortSignal,
) {
    if (provision.initState === "partial")
        throw new Error(
            "An earlier attempt created a cluster on this server but didn't finish setting it up. Retry and confirm the reset to start over.",
        );

    // A confirmed reset targets the cluster Stoat's own earlier attempt created.
    if (provision.initState === "none") {
        log(`Checking ${provision.host} for an existing Uncloud cluster...`);

        const member = await isClusterMember(provision, workspace, signal).catch((error: Error) => {
            if (signal.aborted) throw error;

            throw new Error(initFailure(error.message, provision.user));
        });

        if (member) throw new Error(ALREADY_MEMBER);
    }

    const version = await ucVersion(workspace, signal);

    const args = [
        "machine",
        "init",
        `ssh+go://${sshDestination(provision)}`,
        "--ssh-key",
        workspace.key,
    ];

    if (version) args.push("--version", version);

    // An uncld.dev domain needs the server reachable from the internet; Caddy still serves the LAN.
    if (lan) args.push("--no-dns");

    // Only after the user confirmed resetting the cluster an earlier attempt left behind.
    if (provision.initState === "reset") args.push("--yes");

    log(`Installing Uncloud ${version ?? "(latest)"} on ${provision.host}...`);

    try {
        await runUc(workspace, args, log, signal);
    } catch (error) {
        // uc writes its config only once the cluster exists on the server.
        const created = await access(workspace.config).then(
            () => true,
            () => false,
        );

        // An abort must stay an abort so the job is released, not failed.
        if (signal.aborted || !(error instanceof Error)) throw error;

        // Pointing the apps' uncld.dev domain at the server is init's last step, and Stoat doesn't need it.
        if (created && error.message.includes("no internet-reachable machines")) {
            log(
                "Uncloud couldn't reach this server from the internet on port 80, so the cluster's uncld.dev domain doesn't point to it. Stoat doesn't need it; open ports 80 and 443 if your apps should use it.",
            );
            await setProvisionInitState(db, provision.id, "done");

            return;
        }

        if (created) await setProvisionInitState(db, provision.id, "partial");

        throw new Error(initFailure(error.message, provision.user));
    }

    await setProvisionInitState(db, provision.id, "done");
}

/** A certificate for the sidecar at `host`, which Stoat pins instead of trusting a CA. */
async function sidecarCertificate(host: string, address: string) {
    const altNames: { type: 2 | 7; value?: string; ip?: string }[] = [{ type: 7, ip: address }];

    if (!isIP(host)) altNames.push({ type: 2, value: host });

    return generate([{ name: "commonName", value: host }], {
        keyType: "ec",
        algorithm: "sha256",
        // Pinned rather than trusted through a CA, so it only needs to outlast the cluster.
        notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000),
        extensions: [{ name: "subjectAltName", altNames }],
    });
}

async function waitForSidecar(
    url: string,
    token: string,
    certificate: string,
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

async function provision(
    db: Database,
    request: ClusterProvision,
    workspace: Workspace,
    secret: string,
    log: Log,
    signal: AbortSignal,
) {
    if (!request.encryptedPrivateKey)
        throw new Error("This request's SSH key is gone. Delete it and start again.");

    const server = { ...request, host: await serverAddress(request.host) };
    // Stoat reaches a private server directly, so an internet-facing uncld.dev domain is no use there.
    const lan = isPrivateServerAddress(server.host);

    if (lan) log(`${server.host} is on a private network, so the cluster gets no public domain.`);

    await writeFile(
        workspace.key,
        decryptProvisionKey(request.encryptedPrivateKey, secret, request.id),
        { mode: 0o600 },
    );

    if (request.initState !== "done") await initMachine(db, server, workspace, lan, log, signal);

    await writeFile(workspace.config, clusterConfig(sshDestination(server), workspace.key), {
        mode: 0o600,
    });

    const url = `https://${isIP(request.host) === 6 ? `[${request.host}]` : request.host}:${SIDECAR_PORT}`;
    const certificate = await sidecarCertificate(request.host, server.host);
    const token = randomBytes(32).toString("hex");
    const compose = join(workspace.dir, "compose.yaml");

    await writeFile(compose, sidecarCompose);
    log(`Deploying the Stoat sidecar to ${url}...`);
    await runUc(workspace, ["deploy", "--file", compose, "--yes"], log, signal, {
        SIDECAR_TOKEN: token,
        SIDECAR_TLS_CERT: certificate.cert,
        SIDECAR_TLS_KEY: certificate.private,
    });
    await waitForSidecar(url, token, certificate.cert, log, signal);
    await completeProvision(db, request.id, url, token, certificate.cert);
    log("Cluster is ready.");
}

export async function provisionCluster(
    db: Database,
    provisionId: string,
    requestId: string,
    secret: string,
    signal: AbortSignal,
) {
    const request = await getProvision(db, provisionId);

    // A retry or delete since this job was queued supersedes it.
    if (
        !request ||
        request.requestedAt?.toISOString() !== requestId ||
        (request.status !== "queued" && request.status !== "running")
    )
        return;

    await setProvisionStatus(db, provisionId, "running", null);

    // Lines are written in order without holding up uc's output.
    let pending = Promise.resolve();

    const log: Log = (text, level = "info") => {
        pending = pending.then(() =>
            appendProvisionLog(db, provisionId, text, level).catch(() => {}),
        );
    };

    const dir = await mkdtemp(join(tmpdir(), "stoat-provision-"));
    const workspace = { dir, config: join(dir, "config.yaml"), key: join(dir, "id_ed25519") };

    try {
        await provision(db, request, workspace, secret, log, signal);
    } catch (error) {
        // Interruption is not a failure: the job is released and runs again.
        if (signal.aborted) throw error;

        const message = error instanceof Error ? error.message : "Provisioning failed.";
        log(message, "error");
        await pending;
        await setProvisionStatus(db, provisionId, "failed", message);

        throw new Error(message);
    } finally {
        await pending;
        await rm(dir, { recursive: true, force: true });
    }
}
