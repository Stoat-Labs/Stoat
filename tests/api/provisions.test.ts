import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { organizationHasInfrastructure } from "@stoat/db/organizations";
import { clusters, deployments } from "@stoat/db/schema/index";
import * as uncloud from "@stoat/uncloud";
import { parseCaddyComposeSpec } from "@stoat/workflows/deploy-caddy";
import { provisionCluster, provisioningCredentials } from "@stoat/workflows/provision-cluster";
import { isAllowedServerAddress, isPrivateServerAddress } from "@stoat/workflows/server-address";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { projectsRouter } from "../../packages/api/src/routers/projects";
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
            interrupted)
                echo "current_context: default" > "$config"
                touch "$dir/interrupted"
                exec sleep 30 ;;
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

describe("provisioning credentials", () => {
    it("pairs an OpenSSH public key with its private key and pins a certificate for the host", async () => {
        const credentials = await provisioningCredentials("192.168.1.10", "stoat-test");
        const [type, blob, comment] = credentials.publicKey.split(" ");
        // SAFETY: provisioningCredentials serializes exactly this shape.
        const secrets = JSON.parse(credentials.secrets) as { sshKey: string; tlsKey: string };

        const raw = createPublicKey(secrets.sshKey)
            .export({ format: "der", type: "spki" })
            .subarray(-32);

        expect(type).toBe("ssh-ed25519");
        expect(comment).toBe("stoat-test");
        expect(Buffer.from(blob!, "base64").subarray(-32).equals(raw)).toBe(true);
        expect(new X509Certificate(credentials.certificate).checkIP("192.168.1.10")).toBe(
            "192.168.1.10",
        );
        expect(createPrivateKey(secrets.tlsKey).asymmetricKeyType).toBe("ec");

        const named = await provisioningCredentials("nas.lan", "stoat-test");

        expect(new X509Certificate(named.certificate).checkHost("nas.lan")).toBe("nas.lan");
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
        for (const file of [
            "calls",
            "ssh-calls",
            "deploy",
            "compose",
            "tls-cert",
            "tls-key",
            "interrupted",
        ])
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

    async function create(host = PUBLIC_HOST, caddyStorage = false) {
        const { id } = await call(
            clusterRouter.provisionCluster,
            { name: "Edge", host, caddyStorage },
            { context },
        );

        return id;
    }

    async function start(clusterId: string, reset = false) {
        const { deploymentId } = await call(
            clusterRouter.startProvisioning,
            { clusterId, reset },
            { context },
        );

        return deploymentId;
    }

    // Runs one setup attempt the way the worker does, then reads back where it left things.
    async function attempt(clusterId: string, reset = false) {
        const deploymentId = await start(clusterId, reset);

        await provisionCluster(db, deploymentId, new AbortController().signal).catch(() => {});

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        return { cluster: cluster!, deployment: deployment! };
    }

    function caddyDeployments(clusterId: string) {
        return db
            .select()
            .from(deployments)
            .where(and(eq(deployments.clusterId, clusterId), eq(deployments.name, "DeployCaddy")));
    }

    async function lines(file: string) {
        if (!existsSync(join(bin, file))) return [];

        return (await readFile(join(bin, file), "utf8")).trim().split("\n");
    }

    it("creates the cluster first, sets it up in a job, and forgets its keys", async () => {
        const clusterId = await create();
        const [created] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        const { rows } = await db.$client.query<{ secrets: string }>(
            "SELECT provisioning_secrets AS secrets FROM clusters WHERE id = $1",
            [clusterId],
        );

        expect(created).toMatchObject({
            sidecarUrl: "https://93.184.216.34:51443",
            provisioning: { host: PUBLIC_HOST, port: 22, user: "root", initState: "none" },
        });
        expect(rows[0]!.secrets.startsWith("enc:v1:")).toBe(true);

        const listed = await call(clusterRouter.listClusters, undefined, { context });

        expect(listed.items.find((item) => item.id === clusterId)?.setup).toEqual({
            host: PUBLIC_HOST,
            status: "pending",
        });

        const { cluster, deployment } = await attempt(clusterId);

        expect(deployment).toMatchObject({ name: "ProvisionCluster", status: "ready" });
        expect(cluster.provisioning).toBeNull();
        expect(cluster.provisioningSecrets).toBeNull();
        expect((await readFile(join(bin, "deploy"), "utf8")).trim()).toBe(cluster.sidecarToken);
        expect(await readFile(join(bin, "tls-cert"), "utf8")).toBe(cluster.sidecarCertificate);
        expect(await readFile(join(bin, "compose"), "utf8")).toContain("51443:51443@host");
        expect(await readFile(join(bin, "key"), "utf8")).toContain("BEGIN PRIVATE KEY");
        expect(uncloud.ucClient).toHaveBeenLastCalledWith(cluster.sidecarUrl, {
            token: cluster.sidecarToken,
            certificate: cluster.sidecarCertificate,
        });

        const init = (await lines("calls")).find((line) => line.startsWith("machine init"))!;
        const home = init.match(/home=(\S+)/)![1]!;

        expect(init).toContain("ssh+go://root@93.184.216.34:22");
        expect(init).toContain("--version 0.21.0");
        expect(init).not.toContain("--yes");
        // The cluster still gets an uncld.dev domain for its apps.
        expect(init).not.toContain("--no-dns");
        expect(init).toContain("database=0");
        expect(existsSync(dirname(join(home, "config.yaml")))).toBe(false);
        expect((await lines("ssh-calls"))[0]).toContain("root@93.184.216.34 grep -qs");

        const setup = await call(clusterRouter.getProvisioning, { clusterId }, { context });
        const text = setup.logs.map((line) => line.text);

        expect(setup).toMatchObject({ status: "ready", setup: null });
        expect(text).toContain("Image ghcr.io/stoat-labs/sidecar:latest on edge  Pulled");
        expect(text.some((line) => line.includes("Downloading ["))).toBe(false);
        // Caddy keeps the image uc machine init deployed.
        expect(await caddyDeployments(clusterId)).toEqual([]);
    });

    it("switches Caddy to cluster storage once the cluster is ready, if asked", async () => {
        const clusterId = await create(PUBLIC_HOST, true);
        const { deployment } = await attempt(clusterId);
        const [caddy, ...others] = await caddyDeployments(clusterId);

        expect(deployment.status).toBe("ready");
        expect(others).toEqual([]);
        expect(caddy?.status).toBe("queued");
        expect(parseCaddyComposeSpec(caddy!.spec!)).toEqual({
            image: "ghcr.io/unlabs-dev/caddy-uncloud:0.1.3",
            caddyfile: "{\n\tstorage uncloud\n}\n",
        });
    });

    it("refuses a cluster member without running uc on it", async () => {
        await writeFile(join(bin, "ssh-mode"), "member");
        const { cluster, deployment } = await attempt(await create());

        expect(deployment.status).toBe("failed");
        expect(deployment.error).toContain("already belongs to an Uncloud cluster");
        expect(cluster.provisioning?.initState).toBe("none");
        expect(cluster.provisioningSecrets).not.toBeNull();
        expect((await lines("calls")).some((line) => line.startsWith("machine init"))).toBe(false);
    });

    it("still refuses a member when uc spots it first", async () => {
        await writeFile(join(bin, "mode"), "taken");
        const { deployment } = await attempt(await create());

        expect(deployment.error).toContain("already belongs to an Uncloud cluster");
    });

    it("explains a rejected key and logs the error once", async () => {
        await writeFile(join(bin, "ssh-mode"), "rejected");
        const clusterId = await create();
        const { deployment } = await attempt(clusterId);
        const { logs } = await call(clusterRouter.getProvisioning, { clusterId }, { context });

        expect(deployment.error).toBe(
            "The server rejected Stoat's key. Add the public key to ~/.ssh/authorized_keys for root, then retry.",
        );
        expect(logs.filter((line) => line.level === "error").map((line) => line.text)).toEqual([
            deployment.error,
        ]);
        expect(await lines("calls")).toEqual([]);
    });

    it("only resets a half-created cluster after the user confirms", async () => {
        await writeFile(join(bin, "mode"), "partial");
        const clusterId = await create();
        const failed = await attempt(clusterId);

        expect(failed.deployment.error).toBe("reserve cluster domain in Uncloud DNS: unavailable");
        expect(failed.cluster.provisioning?.initState).toBe("partial");
        await expect(start(clusterId)).rejects.toThrow("Confirm resetting the server");

        await writeFile(join(bin, "mode"), "ok");
        // The reset targets Stoat's own cluster, which the membership check would refuse.
        await writeFile(join(bin, "ssh-mode"), "member");
        const done = await attempt(clusterId, true);

        expect(done.deployment.status).toBe("ready");
        expect(
            (await lines("calls")).filter((line) => line.startsWith("machine init")).at(-1),
        ).toContain("--yes");
        expect(await lines("ssh-calls")).toHaveLength(1);
    });

    it("remembers a half-created cluster when setup is interrupted", async () => {
        await writeFile(join(bin, "mode"), "interrupted");
        const clusterId = await create();
        const deploymentId = await start(clusterId);
        const controller = new AbortController();
        const running = provisionCluster(db, deploymentId, controller.signal);

        await vi.waitFor(() => expect(existsSync(join(bin, "interrupted"))).toBe(true), {
            timeout: 5_000,
        });
        controller.abort();
        await expect(running).rejects.toThrow();

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        expect(cluster!.provisioning?.initState).toBe("partial");

        // The released job runs again and asks for a reset instead of refusing Stoat's own cluster.
        await writeFile(join(bin, "ssh-mode"), "member");
        await provisionCluster(db, deploymentId, new AbortController().signal).catch(() => {});

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        expect(deployment!.error).toContain("confirm the reset");
    });

    it("skips init on a retry once the cluster exists", async () => {
        const clusterId = await create();

        await db
            .update(clusters)
            .set({
                provisioning: sql`jsonb_set(${clusters.provisioning}, '{initState}', '"done"')`,
            })
            .where(eq(clusters.id, clusterId));
        await attempt(clusterId);

        expect((await lines("calls")).some((line) => line.startsWith("machine init"))).toBe(false);
    });

    it("finishes setup when Uncloud can't point the apps' domain at the server", async () => {
        await writeFile(join(bin, "mode"), "unreachable");
        const clusterId = await create();
        const { deployment } = await attempt(clusterId);
        const { logs } = await call(clusterRouter.getProvisioning, { clusterId }, { context });

        expect(deployment.status).toBe("ready");
        expect(
            logs.some((line) => line.text.includes("uncld.dev domain doesn't point to it")),
        ).toBe(true);
    });

    it("skips the public domain on a LAN and accepts Tailscale addresses", async () => {
        const lan = await attempt(await create("192.168.50.10"));
        const calls = await lines("calls");

        expect(lan.deployment.status).toBe("ready");
        expect(lan.cluster.sidecarUrl).toBe("https://192.168.50.10:51443");
        expect(calls.find((line) => line.startsWith("machine init"))).toContain("--no-dns");

        const tailscale = await attempt(await create("100.101.102.103"));

        expect(tailscale.deployment.status).toBe("ready");
        expect(tailscale.cluster.sidecarUrl).toBe("https://100.101.102.103:51443");
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

    it("never connects to loopback, link-local or reserved addresses", async () => {
        for (const host of ["127.0.0.1", "::1", "localhost", "api.LOCALHOST", "169.254.169.254"]) {
            await expect(
                call(clusterRouter.provisionCluster, { name: "Bad", host }, { context }),
            ).rejects.toThrow("Stoat doesn't connect to loopback");
        }

        // A hostname is only resolved by the worker, so it refuses one that points at loopback.
        const clusterId = await create();

        await db
            .update(clusters)
            .set({
                provisioning: sql`jsonb_set(${clusters.provisioning}, '{host}', '"localhost"')`,
            })
            .where(eq(clusters.id, clusterId));
        const { deployment } = await attempt(clusterId);

        expect(deployment.error).toContain("doesn't connect to localhost");
        expect(await lines("ssh-calls")).toEqual([]);
        expect(await lines("calls")).toEqual([]);
    });

    it("keeps a cluster out of use until its setup finishes", async () => {
        const clusterId = await create();

        await expect(
            call(projectsRouter.createProject, { name: "Shop", clusterId }, { context }),
        ).rejects.toThrow("still being set up");
        await expect(
            call(
                clusterRouter.initializeCluster,
                { clusterId, configuration: { machine: "edge", retentionDays: 7 } },
                { context },
            ),
        ).rejects.toThrow("still being set up");

        await start(clusterId);
        await expect(start(clusterId)).rejects.toThrow("Setup is already running");
        await expect(call(clusterRouter.deleteCluster, { clusterId }, { context })).rejects.toThrow(
            "Wait for the cluster's setup",
        );
    });

    it("leaves a cluster out of pickers until its setup finishes", async () => {
        const clusterId = await create();

        const pickable = async () => {
            const { items } = await call(
                clusterRouter.listClusters,
                { includeDiagnostics: false, includeSettingUp: false, limit: 100 },
                { context },
            );

            const observable = await call(clusterRouter.listObservableClusters, undefined, {
                context,
            });

            return [items, observable].map((list) => list.some(({ id }) => id === clusterId));
        };

        expect(await pickable()).toEqual([false, false]);

        await attempt(clusterId);

        expect(await pickable()).toEqual([true, true]);
    });

    it("lets only its organization see, start or delete a setup", async () => {
        const clusterId = await create();

        await expect(
            call(clusterRouter.getProvisioning, { clusterId }, { context: otherContext }),
        ).rejects.toThrow("Cluster not found");
        await expect(
            call(clusterRouter.startProvisioning, { clusterId }, { context: otherContext }),
        ).rejects.toThrow("Cluster not found");
        await expect(
            call(clusterRouter.deleteCluster, { clusterId }, { context: otherContext }),
        ).rejects.toThrow();

        await call(clusterRouter.deleteCluster, { clusterId }, { context });
        expect(await db.select().from(clusters).where(eq(clusters.id, clusterId))).toEqual([]);
    });

    it("keeps the organization from being deleted during its first setup", async () => {
        const ownerId = randomUUID();

        const owned = await insertUserWithOrganization(
            db,
            ownerId,
            "Owner",
            `${ownerId}@example.test`,
        );

        expect(await organizationHasInfrastructure(db, owned)).toBe(false);

        await call(
            clusterRouter.provisionCluster,
            { name: "First", host: PUBLIC_HOST },
            { context: sessionContext(ownerId, owned) },
        );

        expect(await organizationHasInfrastructure(db, owned)).toBe(true);
    });

    it("rejects bad addresses and users, and setup on a finished cluster", async () => {
        await expect(
            call(
                clusterRouter.provisionCluster,
                { name: "Bad", host: "root@93.184.216.34" },
                { context },
            ),
        ).rejects.toThrow();
        await expect(
            call(
                clusterRouter.provisionCluster,
                { name: "Bad", host: "93.184.216.34", user: "-oProxyCommand=x" },
                { context },
            ),
        ).rejects.toThrow();

        const clusterId = await create();

        await attempt(clusterId);
        await expect(start(clusterId)).rejects.toThrow("already set up");
    });
});
