import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { getProvision } from "@stoat/db/provisions";
import { clusterProvisionLogs, clusterProvisions, clusters } from "@stoat/db/schema/index";
import * as uncloud from "@stoat/uncloud";
import { provisionCluster } from "@stoat/workflows/provision-cluster";
import { decryptProvisionKey, generateProvisionKey } from "@stoat/workflows/secrets";
import { isAllowedServerAddress, isPrivateServerAddress } from "@stoat/workflows/server-address";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { insertUserWithOrganization } from "../users";

const secret = "a-secure-test-encryption-key-32-characters";

// A server on the public internet. uc and ssh are fakes, so nothing ever connects to it.
const PUBLIC_HOST = "93.184.216.34";

// Stands in for the bundled uc: records each call and acts out the scenario in `mode`.
const fakeUc = `#!/bin/sh
dir=$(dirname "$0")
config=$2
shift 2
echo "$* home=$HOME database=$(env | grep -c '^DATABASE_URL=')" >> "$dir/calls"
case "$1" in
    version) printf '0.21.0' ;;
    machine)
        while [ "$#" -gt 0 ]; do
            if [ "$1" = "--ssh-key" ]; then head -n 1 "$2" > "$dir/key"; fi
            shift
        done
        case "$(cat "$dir/mode")" in
            taken)
                echo "Error: the remote machine is already initialised as a cluster member" >&2
                exit 1 ;;
            partial)
                echo "current_context: default" > "$config"
                echo "Connecting to ssh+go://root@93.184.216.34:22" >&2
                echo "Error: reserve cluster domain in Uncloud DNS: unavailable" >&2
                exit 1 ;;
            unreachable)
                echo "current_context: default" > "$config"
                echo "Error: failed to update DNS records pointing to caddy service: no internet-reachable machines running service containers" >&2
                exit 1 ;;
        esac
        echo "Cluster initialised"
        echo "current_context: default" > "$config" ;;
    deploy)
        while [ "$#" -gt 0 ]; do
            if [ "$1" = "--file" ]; then cp "$2" "$dir/compose"; fi
            shift
        done
        echo "4da371d9872f on edge Downloading [==>    ]  1.049MB/4.156MB" >&2
        echo "Image ghcr.io/stoat-labs/sidecar:latest on edge  Pulled" >&2
        echo "$SIDECAR_TOKEN" > "$dir/deploy"
        printf '%s' "$SIDECAR_TLS_CERT" > "$dir/tls-cert"
        printf '%s' "$SIDECAR_TLS_KEY" > "$dir/tls-key" ;;
esac
`;

// Stands in for OpenSSH, which checks whether the server already belongs to a cluster.
const fakeSsh = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/ssh-calls"
case "$(cat "$dir/ssh-mode")" in
    member) exit 0 ;;
    rejected)
        echo "root@93.184.216.34: Permission denied (publickey)." >&2
        exit 255 ;;
esac
exit 1
`;

// The new sidecar answers its readiness check at once.
const sidecar = { GET: async () => ({ response: new Response(null, { status: 200 }) }) };

// SAFETY: provisioning only calls GET /readyz and reads the response status.
vi.spyOn(uncloud, "ucClient").mockReturnValue(
    sidecar as typeof sidecar & ReturnType<typeof uncloud.ucClient>,
);

describe("SSH keys for provisioning", () => {
    it("pairs an OpenSSH public key with the encrypted PKCS#8 private key", () => {
        const id = randomUUID();
        const key = generateProvisionKey(secret, id, "stoat-test");
        const [type, blob, comment] = key.publicKey.split(" ");
        const pem = decryptProvisionKey(key.encryptedPrivateKey, secret, id);
        const raw = createPublicKey(pem).export({ format: "der", type: "spki" }).subarray(-32);

        expect(type).toBe("ssh-ed25519");
        expect(comment).toBe("stoat-test");
        expect(Buffer.from(blob!, "base64").subarray(-32).equals(raw)).toBe(true);
        expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
        expect(key.encryptedPrivateKey).not.toContain("PRIVATE KEY");
        expect(() => decryptProvisionKey(key.encryptedPrivateKey, secret, randomUUID())).toThrow();
    });
});

describe("cluster provisioning (PostgreSQL)", () => {
    const databaseName = `stoat_provision_test_${randomUUID().replaceAll("-", "")}`;
    const originalPath = process.env.PATH;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    let otherContext: Context;
    let organizationId: string;
    let bin: string;

    function sessionContext(userId: string, activeOrganizationId: string) {
        // SAFETY: router authorization reads only the identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId } },
        } as Context;
    }

    beforeAll(async () => {
        process.env.APP_SECRET = secret;
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        organizationId = await insertUserWithOrganization(
            db,
            "provisioner",
            "Provisioner",
            "provision@example.test",
        );
        context = sessionContext("provisioner", organizationId);
        otherContext = sessionContext(
            "outsider",
            await insertUserWithOrganization(db, "outsider", "Outsider", "outsider@example.test"),
        );

        bin = await mkdtemp(join(tmpdir(), "stoat-fake-uc-"));
        await writeFile(join(bin, "uc"), fakeUc);
        await writeFile(join(bin, "ssh"), fakeSsh);
        await chmod(join(bin, "uc"), 0o755);
        await chmod(join(bin, "ssh"), 0o755);
        process.env.PATH = `${bin}:${originalPath}`;
    }, 30_000);

    beforeEach(async () => {
        await rm(join(bin, "calls"), { force: true });
        await rm(join(bin, "ssh-calls"), { force: true });

        for (const file of ["deploy", "compose", "tls-cert", "tls-key"])
            await rm(join(bin, file), { force: true });

        await writeFile(join(bin, "mode"), "ok");
        await writeFile(join(bin, "ssh-mode"), "fresh");
    });

    afterAll(async () => {
        process.env.PATH = originalPath;
        await rm(bin, { recursive: true, force: true });
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    async function createAndStart(host = PUBLIC_HOST) {
        const created = await call(
            clusterRouter.createProvision,
            { name: "Edge", host },
            { context },
        );

        await call(clusterRouter.startProvision, { provisionId: created.id }, { context });

        return created.id;
    }

    async function run(provisionId: string) {
        const request = await getProvision(db, provisionId);

        await provisionCluster(
            db,
            provisionId,
            request!.requestedAt!.toISOString(),
            secret,
            new AbortController().signal,
        ).catch(() => {});

        return (await getProvision(db, provisionId))!;
    }

    async function lines(file: string) {
        if (!existsSync(join(bin, file))) return [];

        return (await readFile(join(bin, file), "utf8")).trim().split("\n");
    }

    it("creates the cluster, deploys its sidecar, and forgets the key", async () => {
        const provisionId = await createAndStart();
        const done = await run(provisionId);

        expect(done).toMatchObject({ status: "ready", initState: "done", error: null });
        expect(done.encryptedPrivateKey).toBeNull();

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, done.clusterId!));
        const token = (await readFile(join(bin, "deploy"), "utf8")).trim();
        const certificate = await readFile(join(bin, "tls-cert"), "utf8");

        // Public servers get the same pinned sidecar as private ones, no domain or CA involved.
        expect(cluster).toMatchObject({
            name: "Edge",
            organizationId,
            sidecarUrl: "https://93.184.216.34:51443",
            sidecarToken: token,
            sidecarCertificate: certificate,
        });
        expect(new X509Certificate(certificate).checkIP(PUBLIC_HOST)).toBe(PUBLIC_HOST);
        expect(await readFile(join(bin, "compose"), "utf8")).toContain("51443:51443@host");
        expect(await readFile(join(bin, "key"), "utf8")).toContain("BEGIN PRIVATE KEY");

        const init = (await lines("calls")).find((line) => line.startsWith("machine init"))!;
        const home = init.match(/home=(\S+)/)![1]!;

        expect(init).toContain("ssh+go://root@93.184.216.34:22");
        expect(init).toContain("--version 0.21.0");
        expect(init).not.toContain("--yes");
        // The cluster still gets an uncld.dev domain for its apps.
        expect(init).not.toContain("--no-dns");
        expect(init).toContain("database=0");
        expect(existsSync(dirname(join(home, "config.yaml")))).toBe(false);

        const [check] = await lines("ssh-calls");
        expect(check).toContain("root@93.184.216.34 grep -qs");

        const { logs } = await call(clusterRouter.getProvision, { provisionId }, { context });
        const text = logs.map((line) => line.text);

        expect(text).toContain("Image ghcr.io/stoat-labs/sidecar:latest on edge  Pulled");
        expect(text.some((line) => line.includes("Downloading ["))).toBe(false);

        const listed = await call(clusterRouter.listProvisions, undefined, { context });
        expect(listed.map((provision) => provision.id)).not.toContain(provisionId);
    });

    it("pins a self-signed certificate for a server on the LAN", async () => {
        const done = await run(await createAndStart("192.168.50.10"));

        expect(done.status).toBe("ready");

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, done.clusterId!));
        const certificate = await readFile(join(bin, "tls-cert"), "utf8");
        const token = (await readFile(join(bin, "deploy"), "utf8")).trim();

        expect(cluster).toMatchObject({
            sidecarUrl: "https://192.168.50.10:51443",
            sidecarToken: token,
            sidecarCertificate: certificate,
        });
        expect(new X509Certificate(certificate).checkIP("192.168.50.10")).toBe("192.168.50.10");
        expect(
            createPrivateKey(await readFile(join(bin, "tls-key"), "utf8")).asymmetricKeyType,
        ).toBe("ec");
        expect(await readFile(join(bin, "compose"), "utf8")).toContain("51443:51443@host");
        expect(uncloud.ucClient).toHaveBeenLastCalledWith("https://192.168.50.10:51443", {
            token,
            certificate,
        });

        const calls = await lines("calls");

        expect(calls.find((line) => line.startsWith("machine init"))).toContain("--no-dns");
        expect(calls.some((line) => line.startsWith("dns"))).toBe(false);
    });

    it("finishes setup when Uncloud can't point the apps' domain at the server", async () => {
        await writeFile(join(bin, "mode"), "unreachable");
        const provisionId = await createAndStart();
        const done = await run(provisionId);
        const { logs } = await call(clusterRouter.getProvision, { provisionId }, { context });

        expect(done).toMatchObject({ status: "ready", initState: "done" });
        expect(
            logs.some((line) => line.text.includes("uncld.dev domain doesn't point to it")),
        ).toBe(true);
    });

    it("treats Tailscale addresses as a private network", async () => {
        const done = await run(await createAndStart("100.101.102.103"));
        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, done.clusterId!));

        expect(cluster!.sidecarUrl).toBe("https://100.101.102.103:51443");
        expect(cluster!.sidecarCertificate).toContain("BEGIN CERTIFICATE");
    });

    it("tells private networks from the internet and never allows metadata services", () => {
        for (const address of [
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.10",
            "100.64.0.1",
            "fd7a:115c:a1e0::1",
        ])
            expect(isPrivateServerAddress(address), address).toBe(true);

        for (const address of [PUBLIC_HOST, "172.32.0.1", "100.128.0.1", "2606:4700::1111"])
            expect(isPrivateServerAddress(address), address).toBe(false);

        for (const address of ["100.101.102.103", "192.168.1.10", PUBLIC_HOST])
            expect(isAllowedServerAddress(address), address).toBe(true);

        for (const address of [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.169.254",
            "100.100.100.200",
            "::1",
            "fe80::1",
            "fd00:ec2::254",
        ])
            expect(isAllowedServerAddress(address), address).toBe(false);
    });

    it("refuses a cluster member without running uc on it", async () => {
        await writeFile(join(bin, "ssh-mode"), "member");
        const failed = await run(await createAndStart());

        expect(failed).toMatchObject({ status: "failed", initState: "none" });
        expect(failed.error).toContain("already belongs to an Uncloud cluster");
        expect(failed.encryptedPrivateKey).not.toBeNull();
        expect((await lines("calls")).some((line) => line.startsWith("machine init"))).toBe(false);
    });

    it("still refuses a member when uc spots it first", async () => {
        await writeFile(join(bin, "mode"), "taken");
        const failed = await run(await createAndStart());

        expect(failed).toMatchObject({ status: "failed", initState: "none" });
        expect(failed.error).toContain("already belongs to an Uncloud cluster");
    });

    it("explains a rejected key and logs the error once", async () => {
        await writeFile(join(bin, "ssh-mode"), "rejected");
        const provisionId = await createAndStart();
        const failed = await run(provisionId);
        const { logs } = await call(clusterRouter.getProvision, { provisionId }, { context });

        expect(failed.error).toBe(
            "The server rejected Stoat's key. Add the public key to ~/.ssh/authorized_keys for root, then retry.",
        );
        expect(logs.filter((line) => line.level === "error").map((line) => line.text)).toEqual([
            failed.error,
        ]);
        expect(await lines("calls")).toEqual([]);
    });

    it("only resets a half-created cluster after the user confirms", async () => {
        await writeFile(join(bin, "mode"), "partial");
        const provisionId = await createAndStart();
        const failed = await run(provisionId);

        expect(failed).toMatchObject({ status: "failed", initState: "partial" });
        expect(failed.error).toBe("reserve cluster domain in Uncloud DNS: unavailable");

        await expect(
            call(clusterRouter.startProvision, { provisionId }, { context }),
        ).rejects.toThrow("Confirm resetting the server");

        await writeFile(join(bin, "mode"), "ok");
        // The reset targets Stoat's own cluster, which the membership check would refuse.
        await writeFile(join(bin, "ssh-mode"), "member");
        await call(clusterRouter.startProvision, { provisionId, reset: true }, { context });
        const done = await run(provisionId);

        expect(done.status).toBe("ready");
        expect(
            (await lines("calls")).filter((line) => line.startsWith("machine init")).at(-1),
        ).toContain("--yes");
        expect(await lines("ssh-calls")).toHaveLength(1);
    });

    it("skips init on a retry once the cluster exists", async () => {
        const provisionId = await createAndStart();

        await db
            .update(clusterProvisions)
            .set({ initState: "done" })
            .where(eq(clusterProvisions.id, provisionId));
        await run(provisionId);

        expect((await lines("calls")).some((line) => line.startsWith("machine init"))).toBe(false);
    });

    it("never connects to loopback, link-local or reserved addresses", async () => {
        for (const host of ["127.0.0.1", "::1", "localhost", "api.LOCALHOST", "169.254.169.254"]) {
            await expect(
                call(clusterRouter.createProvision, { name: "Bad", host }, { context }),
            ).rejects.toThrow("Stoat doesn't connect to loopback");
        }

        // A hostname is only resolved by the worker, so it refuses one that points at loopback.
        const provisionId = await createAndStart();

        await db
            .update(clusterProvisions)
            .set({ host: "localhost" })
            .where(eq(clusterProvisions.id, provisionId));
        const failed = await run(provisionId);

        expect(failed.error).toContain("doesn't connect to localhost");
        expect(await lines("ssh-calls")).toEqual([]);
        expect(await lines("calls")).toEqual([]);
    });

    it("keeps the newest log lines when there are too many to show", async () => {
        const provisionId = await createAndStart();

        await db.insert(clusterProvisionLogs).values(
            Array.from({ length: 2100 }, (_, index) => ({
                provisionId,
                text: `line ${index}`,
                level: "info" as const,
            })),
        );
        const { logs } = await call(clusterRouter.getProvision, { provisionId }, { context });

        expect(logs).toHaveLength(2000);
        expect(logs.at(-1)!.text).toBe("line 2099");
        expect(logs[0]!.text).toBe("line 100");
    });

    it("rejects bad addresses and deletes only waiting or failed requests", async () => {
        await expect(
            call(
                clusterRouter.createProvision,
                { name: "Bad", host: "root@93.184.216.34" },
                { context },
            ),
        ).rejects.toThrow();
        await expect(
            call(
                clusterRouter.createProvision,
                { name: "Bad", host: "93.184.216.34", user: "-oProxyCommand=x" },
                { context },
            ),
        ).rejects.toThrow();

        const ready = await run(await createAndStart());
        await expect(
            call(clusterRouter.deleteProvision, { provisionId: ready.id }, { context }),
        ).rejects.toThrow("Only waiting or failed requests");

        const created = await call(
            clusterRouter.createProvision,
            { name: "Waiting", host: "edge.example.test", port: 2222, user: "ubuntu" },
            { context },
        );

        // Another organization can't tell the request exists.
        await expect(
            call(
                clusterRouter.deleteProvision,
                { provisionId: created.id },
                { context: otherContext },
            ),
        ).rejects.toThrow("Request not found");

        await call(clusterRouter.deleteProvision, { provisionId: created.id }, { context });
        expect(await getProvision(db, created.id)).toBeNull();
    });
});
