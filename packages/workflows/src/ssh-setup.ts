import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { isAllowedServerAddress } from "./server-address";

export type Log = (text: string, level?: "info" | "error", event?: string) => void;

// The job's temp directory is also uc's HOME, so its config and SSH state never outlive the job.
export type Workspace = { dir: string; config: string; key: string };

export type Server = { host: string; port: number; user: string };

// Docker reports every image layer's progress; the image's own Pulling and Pulled lines are enough.
const LAYER_PROGRESS = /^[0-9a-f]{12} on \S+ /;

/** A private temp directory for one job's uc config, SSH key and sockets. */
export async function createWorkspace(prefix: string): Promise<Workspace> {
    const dir = await mkdtemp(join(tmpdir(), prefix));

    return { dir, config: join(dir, "config.yaml"), key: join(dir, "id_ed25519") };
}

// An SSH wire-format string: a 32-bit length, then the bytes.
function sshString(value: Buffer) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);

    return Buffer.concat([length, value]);
}

/** A single-use ed25519 key: the OpenSSH public key to authorize, and the PEM private key. */
export function sshKeyPair(comment: string) {
    const ssh = generateKeyPairSync("ed25519");
    const raw = ssh.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);

    return {
        publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
        privateKey: ssh.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    };
}

/** `user@host:port`, with IPv6 hosts in brackets. */
export function sshDestination(server: Server) {
    const host = server.host.includes(":") ? `[${server.host}]` : server.host;

    return `${server.user}@${host}:${server.port}`;
}

export function runUc(
    workspace: Workspace,
    args: string[],
    log: Log,
    signal: AbortSignal,
    env: Record<string, string> = {},
) {
    return new Promise<string>((resolve, reject) => {
        // No app secrets, no SSH agent, and never UNCLOUD_AUTO_CONFIRM, which would let uc reset a server.
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

/** Turns SSH errors from uc or OpenSSH into something the user can act on. */
export function sshFailure(message: string, user: string) {
    if (message.includes("unable to authenticate") || message.includes("Permission denied"))
        return `The server rejected Stoat's key. Add the public key to ~/.ssh/authorized_keys for ${user}, then retry.`;

    // The key's temporary path means nothing to the user.
    return message.replace(/connect using private key "[^"]*": /, "");
}

/** The address to connect to: LAN, Tailscale and public servers yes, loopback and metadata never. */
export async function serverAddress(host: string) {
    const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => []);

    if (!addresses.length) throw new Error(`Stoat couldn't resolve ${host}.`);

    if (addresses.some(({ address }) => !isAllowedServerAddress(address)))
        throw new Error(
            `Stoat doesn't connect to ${host}: it points to a loopback, link-local or reserved address.`,
        );

    // Connecting to the checked address means a DNS change can't redirect the job.
    return addresses[0]!.address;
}

/** The server's cluster member ID read over SSH, since uc reinstalls a member's daemon first: "" if unreadable, null if none. */
export function existingMachineId(server: Server, workspace: Workspace, signal: AbortSignal) {
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
        // Only the ID, the state's first field: the file also holds private keys. A fresh server's is "".
        `${sudo}grep -o -m 1 '"ID": *"[^"][^"]*"' /var/lib/uncloud/machine.json`,
    ];

    return new Promise<string | null>((resolve, reject) => {
        const child = spawn("ssh", args, {
            env: { PATH: process.env.PATH ?? "", HOME: workspace.dir },
            stdio: ["ignore", "pipe", "pipe"],
            signal,
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
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
            else resolve(code === 0 ? (/"ID": *"([^"]*)"/.exec(stdout)?.[1] ?? "") : null);
        });
    });
}

/** The bundled uc's own version, so the daemon it installs always matches it. */
export async function ucVersion(workspace: Workspace, signal: AbortSignal) {
    const output = await runUc(
        workspace,
        ["version", "--output", "{{.Version}}"],
        () => {},
        signal,
    );

    const version = output.trim();

    return /^v?\d+\.\d+\.\d+$/.test(version) ? version : null;
}
