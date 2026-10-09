import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GenericContainer, Wait } from "testcontainers";
import * as v from "valibot";

/** The Compose file the seeded repository starts with. */
export const initialCompose = "services:\n  web:\n    image: nginx:alpine\n";

const serverFile = resolve(import.meta.dirname, "../../test-results/e2e/git-server.json");

const serverSchema = v.object({
    containerId: v.string(),
    address: v.string(),
    serverUrl: v.string(),
    repositoryUrl: v.string(),
    privateKey: v.string(),
    knownHosts: v.string(),
});

/**
 * An SSH Git server: OpenSSH with `git-shell`, a client key it trusts, and one bare repository
 * holding `compose.yaml` on `main`. Stoat reaches it at its Docker network address, a private
 * address like any self-hosted server on the LAN.
 * The image already ships sshd, git, and a `git` user, so nothing is downloaded at startup.
 */
export async function startGitServer() {
    const container = await new GenericContainer("rockstorm/git-server:2.47")
        .withEntrypoint(["sh"])
        .withCommand([
            "-ec",
            [
                "ssh-keygen -A",
                "mkdir /keys && ssh-keygen -q -t ed25519 -N '' -f /keys/client",
                "mkdir -p /home/git/.ssh && cp /keys/client.pub /home/git/.ssh/authorized_keys",
                "git init -q --bare -b main /srv/git/app.git",
                "git clone -q /srv/git/app.git /tmp/seed",
                `printf '${initialCompose.replaceAll("\n", "\\n")}' > /tmp/seed/compose.yaml`,
                "git -C /tmp/seed add compose.yaml",
                "git -C /tmp/seed -c user.name=e2e -c user.email=e2e@example.test commit -qm 'Add compose'",
                "git -C /tmp/seed push -q origin main",
                "chown -R git:git /srv/git /home/git",
                "chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys",
                "exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no",
            ].join("\n"),
        ])
        .withWaitStrategy(Wait.forLogMessage(/Server listening on 0\.0\.0\.0/u))
        .start();

    const read = async (path: string) => (await container.exec(["cat", path])).output.trim();
    const address = container.getIpAddress("bridge");
    // known_hosts: "<host> <type> <key>", without the key's comment.
    const hostKey = (await read("/etc/ssh/ssh_host_ed25519_key.pub")).split(" ").slice(0, 2);

    const server = {
        containerId: container.getId(),
        address,
        serverUrl: `ssh://${address}/srv/git`,
        repositoryUrl: `ssh://${address}/srv/git/app.git`,
        privateKey: `${await read("/keys/client")}\n`,
        knownHosts: `${address} ${hostKey.join(" ")}\n`,
    } satisfies v.InferOutput<typeof serverSchema>;

    writeFileSync(serverFile, JSON.stringify(server));

    return { container, address };
}

/** The Git server global setup started, for specs in other processes. */
export function gitServer() {
    return v.parse(serverSchema, JSON.parse(readFileSync(serverFile, "utf8")));
}

/** Runs a shell command in the Git server's container as its `git` user. */
export function onGitServer(command: string) {
    return execFileSync(
        "docker",
        ["exec", "-u", "git", gitServer().containerId, "sh", "-ec", command],
        {
            encoding: "utf8",
        },
    );
}

/** The file at `path` on `main`, as the server has it. */
export function committedFile(path: string) {
    return onGitServer(`git -C /srv/git/app.git show main:${path}`);
}

/** Commits `content` to `path` on `main`, as if someone pushed from elsewhere. */
export function commitOnServer(path: string, content: string, message: string) {
    onGitServer(
        [
            "rm -rf /tmp/work && git clone -q /srv/git/app.git /tmp/work",
            `printf '%s' '${content.replaceAll("'", "'\\''")}' > /tmp/work/${path}`,
            `git -C /tmp/work add ${path}`,
            `git -C /tmp/work -c user.name=someone -c user.email=someone@example.test commit -qm '${message}'`,
            "git -C /tmp/work push -q origin main",
        ].join("\n"),
    );
}
