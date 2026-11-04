import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { markPendingMachineJoining, setPendingMachineJoined } from "@stoat/db/clusters";
import { cancelDeployment } from "@stoat/db/deployments";
import { clusters, deploymentLogs, deployments } from "@stoat/db/schema/index";
import * as uncloud from "@stoat/uncloud";
import { addMachine, clusterVersion } from "@stoat/workflows/add-machine";
import { ALLOY_SERVICE } from "@stoat/workflows/monitoring-compose";
import { eq, sql } from "drizzle-orm";
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
        case "$2" in
            rm) echo "Machine removed" ;;
            add)
                cp "$config" "$dir/config"
                while [ "$#" -gt 0 ]; do
                    if [ "$1" = "--ssh-key" ]; then head -n 1 "$2" > "$dir/key"; fi
                    shift
                done
                case "$(cat "$dir/mode")" in
                    member)
                        echo "Error: the remote machine is already initialised as a cluster member; cannot ask to confirm reset in non-interactive mode, use --yes flag or set UNCLOUD_AUTO_CONFIRM=true to auto-confirm" >&2
                        exit 1 ;;
                    stale)
                        echo ok > "$dir/mode"
                        echo "Error: add machine to cluster (context 'default'): rpc error: code = AlreadyExists desc = machine with public key \\"a2V5\\" already exists under the name \\"ghost\\"" >&2
                        exit 1 ;;
                esac
                touch "$dir/added"
                echo "Machine 'worker' added to the cluster (context 'default')." ;;
        esac ;;
esac
`;

// Stands in for OpenSSH, which reads the ID of the cluster member a server already is.
const fakeSsh = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/ssh-calls"
case "$(cat "$dir/ssh-mode")" in
    joined) echo '"ID": "machine-new"'; exit 0 ;;
    other) echo '"ID": "c0ffee"'; exit 0 ;;
    rejected)
        echo "root@93.184.216.34: Permission denied (publickey)." >&2
        exit 255 ;;
esac
exit 1
`;

type FakeMachine = {
    id: string;
    name: string;
    state: string;
    daemonVersion?: string;
    publicIp?: string;
};

type FakeService = { name: string; mode: string; machines: string[] };

type FakeSidecar = {
    relay: number;
    geoip: boolean;
    // The server being added, once uc added it.
    added: FakeMachine;
    machines: FakeMachine[];
    services: FakeService[];
    spread: string[];
    // How it answers removing a machine, and the machines it removed.
    removal: { status: number; error: string };
    removed: string[];
    // The cluster's domain, how it answers pointing it at the ingress machines, and how often it did.
    domain: { domain: string; reserved: boolean } | null;
    records: { status: number; error: string };
    pointed: number;
};

/** The sidecar as the job sees it: machines, services, and what it was asked to spread. */
const sidecar: FakeSidecar = {
    relay: 426,
    geoip: true,
    added: { id: "machine-new", name: "worker", state: "Up" },
    machines: [],
    services: [],
    spread: [],
    removal: { status: 200, error: "" },
    removed: [],
    domain: null,
    records: { status: 200, error: "" },
    pointed: 0,
};

// Uncloud machine IDs are 32 hex characters.
const OLD_WORKER = "0f".repeat(16);

const STALE = "ab".repeat(16);

let bin: string;

function machines() {
    return existsSync(join(bin, "added")) ? [...sidecar.machines, sidecar.added] : sidecar.machines;
}

function ok<T>(data: T) {
    return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function failed(status: number, error = "not found") {
    return {
        data: undefined,
        error: { error },
        response: new Response(null, { status }),
    };
}

function serviceResponse(service: FakeService) {
    return {
        id: `svc-${service.name}`,
        name: service.name,
        mode: service.mode,
        containers: service.machines.map((machineId) => ({ machineId, machineName: machineId })),
    };
}

const fakeClient = {
    baseUrl: "https://sidecar.test:51443",
    GET: async (path: string, options: { params?: { path?: { id: string } } } = {}) => {
        if (path === "/api/v1/cluster/connect")
            return { response: new Response(null, { status: sidecar.relay }) };

        if (path === "/api/v1/machines") return ok({ items: machines() });

        if (path === "/api/v1/services")
            return ok({ items: sidecar.services.map(serviceResponse) });

        if (path === "/api/v1/cluster/domain")
            return sidecar.domain ? ok(sidecar.domain) : failed(404);

        const service = sidecar.services.find(({ name }) => name === options.params?.path?.id);

        return service ? ok(serviceResponse(service)) : failed(404);
    },
    POST: async () =>
        ok({ exitCode: sidecar.geoip ? 0 : 1, stdout: "", stderr: "", truncated: false }),
    // Like Uncloud DNS: the wildcard record lists every public machine.
    PUT: async () => {
        if (sidecar.records.status !== 200)
            return failed(sidecar.records.status, sidecar.records.error);

        sidecar.pointed++;

        return ok({
            domain: sidecar.domain!.domain,
            records: [
                {
                    name: "*",
                    type: "A",
                    values: machines().flatMap(({ publicIp }) => (publicIp ? [publicIp] : [])),
                },
            ],
        });
    },
    DELETE: async (_path: string, options: { params: { path: { id: string } } }) => {
        if (sidecar.removal.status !== 200)
            return failed(sidecar.removal.status, sidecar.removal.error);

        const machine = machines().find(({ id }) => id === options.params.path.id);

        if (!machine) return failed(404);

        sidecar.removed.push(machine.id);
        sidecar.machines = sidecar.machines.filter(({ id }) => id !== machine.id);

        // Like the sidecar, only a machine that answers is reset.
        return ok({
            id: machine.id,
            name: machine.name,
            containers: 3,
            reset: machine.state === "Up",
        });
    },
    stream: {
        // Like the sidecar: a container on every machine that is up and has none.
        async *spreadService(name: string) {
            sidecar.spread.push(name);
            const service = sidecar.services.find((item) => item.name === name)!;

            const targets = machines().flatMap((machine) =>
                machine.state === "Up" && !service.machines.includes(machine.id) ? [machine] : [],
            );

            if (targets.length)
                yield {
                    type: "plan",
                    operations: targets.map((machine) => ({
                        action: "run",
                        resource: "container",
                        service: name,
                        machine: machine.name,
                    })),
                };

            for (const machine of targets) {
                service.machines.push(machine.id);
                yield {
                    type: "progress",
                    id: `Container ${name}-abcd on ${machine.name}`,
                    phase: "done",
                    statusText: "Started",
                };
            }

            yield { type: "complete", status: targets.length ? "deployed" : "up to date" };
        },
    },
};

// SAFETY: the job only calls the methods above, with the paths they answer.
vi.spyOn(uncloud, "ucClient").mockReturnValue(
    fakeClient as typeof fakeClient & ReturnType<typeof uncloud.ucClient>,
);

const relays: string[] = [];

// Why the relay last failed to open a connection, as the real one reports it.
let relayError: Error | null = null;

// The relay itself is covered by tests/uncloud; here uc never connects to it.
vi.spyOn(uncloud, "serveUncloudSocket").mockImplementation(async (_url, path) => {
    relays.push(path);

    return { error: relayError, close: async () => {} };
});

describe("the cluster's daemon version", () => {
    it("is the newest one reported, so the new machine doesn't drift", () => {
        expect(
            clusterVersion([
                { daemonVersion: "0.9.2" },
                { daemonVersion: "v0.21.0" },
                { daemonVersion: "0.20.4" },
            ]),
        ).toBe("0.21.0");
        expect(clusterVersion([{ daemonVersion: "dev" }, {}])).toBeNull();
    });
});

describe("adding machines (PostgreSQL)", () => {
    const databaseName = `stoat_machines_test_${randomUUID().replaceAll("-", "")}`;
    const originalPath = process.env.PATH;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    let otherContext: Context;
    let memberContext: Context;
    let organizationId: string;

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
            "adder",
            "Adder",
            "adder@example.test",
        );
        context = sessionContext("adder", organizationId);
        otherContext = sessionContext(
            "stranger",
            await insertUserWithOrganization(db, "stranger", "Stranger", "stranger@example.test"),
        );
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('machine-member', 'Member', 'machine-member@example.test')`,
        );
        await db.$client.query(
            `INSERT INTO member (id, organization_id, user_id, role, created_at)
             VALUES ($1, $2, 'machine-member', 'member', now())`,
            [randomUUID(), organizationId],
        );
        memberContext = sessionContext("machine-member", organizationId);

        bin = await mkdtemp(join(tmpdir(), "stoat-fake-uc-"));
        await writeFile(join(bin, "uc"), fakeUc);
        await writeFile(join(bin, "ssh"), fakeSsh);
        await chmod(join(bin, "uc"), 0o755);
        await chmod(join(bin, "ssh"), 0o755);
        process.env.PATH = `${bin}:${originalPath}`;
    }, 30_000);

    beforeEach(async () => {
        for (const file of ["calls", "ssh-calls", "config", "key", "added"])
            await rm(join(bin, file), { force: true });

        await writeFile(join(bin, "mode"), "ok");
        await writeFile(join(bin, "ssh-mode"), "fresh");
        relays.length = 0;
        relayError = null;
        Object.assign(sidecar, {
            relay: 426,
            geoip: true,
            added: { id: "machine-new", name: "worker", state: "Up" },
            machines: [{ id: "machine-1", name: "edge", state: "Up", daemonVersion: "0.21.0" }],
            services: [
                { name: "sidecar", mode: "global", machines: ["machine-1"] },
                { name: "caddy", mode: "global", machines: ["machine-1"] },
                { name: ALLOY_SERVICE, mode: "global", machines: ["machine-1"] },
                { name: "node-exporter", mode: "global", machines: ["machine-1"] },
                { name: "web", mode: "replicated", machines: ["machine-1"] },
            ],
            spread: [],
            removal: { status: 200, error: "" },
            removed: [],
            domain: null,
            records: { status: 200, error: "" },
            pointed: 0,
        });
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

    async function createCluster(monitored = true) {
        const id = randomUUID();

        await db.insert(clusters).values({
            id,
            organizationId,
            name: `Edge ${id.slice(0, 4)}`,
            sidecarUrl: "https://93.184.216.34:51443",
            sidecarToken: "sidecar-token-0123456789",
            initializedAt: monitored ? new Date() : null,
        });

        return id;
    }

    async function prepare(clusterId: string, host = PUBLIC_HOST, name?: string) {
        return call(
            clusterRouter.prepareMachine,
            { clusterId, host, ...(name && { name }) },
            { context },
        );
    }

    async function start(clusterId: string) {
        const { deploymentId } = await call(clusterRouter.addMachine, { clusterId }, { context });

        return deploymentId;
    }

    // Runs one attempt the way the worker does, then reads back where it left things.
    async function attempt(clusterId: string) {
        const deploymentId = await start(clusterId);

        await addMachine(db, deploymentId, new AbortController().signal).catch(() => {});

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        return { cluster: cluster!, deployment: deployment! };
    }

    async function lines(file: string) {
        if (!existsSync(join(bin, file))) return [];

        return (await readFile(join(bin, file), "utf8")).trim().split("\n");
    }

    async function remove(clusterId: string, machineId: string, caller = context) {
        return call(clusterRouter.removeMachine, { clusterId, machineId }, { context: caller });
    }

    async function joined(clusterId: string) {
        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        return cluster!.pendingMachine?.joined;
    }

    async function logs(deploymentId: string) {
        const rows = await db
            .select({ text: deploymentLogs.text, metadata: deploymentLogs.metadata })
            .from(deploymentLogs)
            .where(eq(deploymentLogs.deploymentId, deploymentId))
            .orderBy(deploymentLogs.id);

        return rows;
    }

    it("adds a server through the sidecar, spreads Stoat's services to it, and forgets its key", async () => {
        const clusterId = await createCluster();
        const { publicKey } = await prepare(clusterId);

        const { rows } = await db.$client.query<{ key: string }>(
            "SELECT pending_machine_key AS key FROM clusters WHERE id = $1",
            [clusterId],
        );

        expect(publicKey).toMatch(/^ssh-ed25519 \S+ stoat-/);
        expect(rows[0]!.key.startsWith("enc:v1:")).toBe(true);
        expect(await call(clusterRouter.getPendingMachine, { clusterId }, { context })).toEqual({
            host: PUBLIC_HOST,
            port: 22,
            user: "root",
            name: null,
            publicKey,
            joined: false,
            status: "pending",
            deploymentId: null,
        });

        const { cluster, deployment } = await attempt(clusterId);

        expect(deployment).toMatchObject({ name: "AddMachine", status: "ready" });
        expect(cluster.pendingMachine).toBeNull();
        expect(cluster.pendingMachineKey).toBeNull();
        expect(await call(clusterRouter.getPendingMachine, { clusterId }, { context })).toBeNull();

        const add = (await lines("calls")).find((line) => line.startsWith("machine add"))!;

        expect(add).toContain(`ssh+go://root@${PUBLIC_HOST}:22`);
        expect(add).toContain("--no-caddy");
        expect(add).toContain("--version 0.21.0");
        expect(add).not.toContain("--yes");
        expect(add).not.toContain("--public-ip");
        expect(add).not.toContain("--name");
        expect(add).toContain("database=0");
        expect(await readFile(join(bin, "key"), "utf8")).toContain("BEGIN PRIVATE KEY");

        // uc reaches the cluster only through the relay, on a socket in the job's private directory.
        expect(relays).toHaveLength(1);
        expect(await readFile(join(bin, "config"), "utf8")).toContain(`unix: ${relays[0]}`);
        expect(existsSync(relays[0]!)).toBe(false);
        expect((await lines("ssh-calls"))[0]).toContain(`root@${PUBLIC_HOST} grep -o -m 1`);

        expect(sidecar.spread).toEqual(["sidecar", "caddy", ALLOY_SERVICE]);

        const text = (await logs(deployment.id)).map((line) => line.text);

        expect(text).toContain(
            "Global services not on worker yet: node-exporter. Redeploy any that should run there.",
        );
        expect(text).toContain("worker is part of the cluster.");
        // Spread steps keep their tags for the deployment page.
        expect((await logs(deployment.id)).some((line) => line.metadata.event === "plan")).toBe(
            true,
        );
    });

    it("names the machine, and keeps a private server out of the public domain", async () => {
        const clusterId = await createCluster(false);

        sidecar.machines = [
            { id: "machine-1", name: "edge", state: "Up", daemonVersion: "0.20.1" },
            { id: "machine-2", name: "edge-2", state: "Up", daemonVersion: "v0.20.3" },
        ];
        sidecar.added = { id: "machine-new", name: "worker-2", state: "Up" };
        await prepare(clusterId, "192.168.50.20", " Worker-2 ");

        const { deployment } = await attempt(clusterId);
        const add = (await lines("calls")).find((line) => line.startsWith("machine add"))!;

        expect(deployment.status).toBe("ready");
        expect(add).toContain("--name worker-2");
        expect(add).toContain("--public-ip none");
        expect(add).toContain("--version 0.20.3");
        // Monitoring isn't set up, so Alloy stays where it is.
        expect(sidecar.spread).toEqual(["sidecar", "caddy"]);
    });

    it("refuses a server that belongs to another cluster without running uc", async () => {
        await writeFile(join(bin, "ssh-mode"), "other");
        const clusterId = await createCluster();

        await prepare(clusterId);

        const { cluster, deployment } = await attempt(clusterId);

        expect(deployment.status).toBe("failed");
        expect(deployment.error).toContain("already belongs to another Uncloud cluster");
        expect(cluster.pendingMachineKey).not.toBeNull();
        expect(await lines("calls")).toEqual([]);

        // uc refuses one the check missed, too.
        await writeFile(join(bin, "ssh-mode"), "fresh");
        await writeFile(join(bin, "mode"), "member");
        expect((await attempt(clusterId)).deployment.error).toContain("already belongs to another");
    });

    it("finishes a server that an earlier attempt added before it stopped", async () => {
        await writeFile(join(bin, "ssh-mode"), "joined");
        const clusterId = await createCluster();

        sidecar.machines.push(sidecar.added);
        await prepare(clusterId);
        // The earlier attempt ran uc, then stopped before it saved that the server joined.
        await markPendingMachineJoining(db, clusterId);

        const { deployment } = await attempt(clusterId);

        expect(deployment.status).toBe("ready");
        expect((await lines("calls")).some((line) => line.startsWith("machine add"))).toBe(false);
        expect(sidecar.spread).toEqual(["sidecar", "caddy", ALLOY_SERVICE]);
    });

    it("refuses a server that already is one of the cluster's machines", async () => {
        await writeFile(join(bin, "ssh-mode"), "joined");
        const clusterId = await createCluster();

        sidecar.machines.push(sidecar.added);
        await prepare(clusterId);

        const { cluster, deployment } = await attempt(clusterId);

        expect(deployment.error).toBe(
            `${PUBLIC_HOST} is already worker in this cluster. Discard it and add another server.`,
        );
        expect(cluster.pendingMachineKey).not.toBeNull();
        expect(await lines("calls")).toEqual([]);
        expect(sidecar.spread).toEqual([]);
    });

    it("adds a joined server again once it was removed from the cluster", async () => {
        const clusterId = await createCluster();

        await prepare(clusterId);
        // Removed after it joined, like a removal that outlived Stoat's wait for it.
        await setPendingMachineJoined(db, clusterId, { id: STALE, name: "stale" });

        const { deployment } = await attempt(clusterId);

        expect(deployment.status).toBe("ready");
        expect(await lines("calls")).toContainEqual(expect.stringContaining("machine add"));
        expect((await logs(deployment.id)).map(({ text }) => text)).toContain(
            "stale is no longer in the cluster.",
        );
    });

    it("only spreads services on a retry once the server joined", async () => {
        const clusterId = await createCluster();

        await prepare(clusterId);
        sidecar.geoip = false;

        const failed = await attempt(clusterId);

        expect(failed.deployment.error).toBe(
            "worker has no GeoIP database, which Alloy needs. Update the Stoat sidecar, then retry.",
        );
        expect(failed.cluster.pendingMachine?.joined).toEqual({
            id: "machine-new",
            name: "worker",
        });
        expect(
            await call(clusterRouter.getPendingMachine, { clusterId }, { context }),
        ).toMatchObject({
            joined: true,
            status: "failed",
            deploymentId: failed.deployment.id,
        });

        sidecar.geoip = true;
        await rm(join(bin, "calls"));
        await rm(join(bin, "ssh-calls"));

        const retried = await attempt(clusterId);

        expect(retried.deployment.status).toBe("ready");
        expect(await lines("calls")).toEqual([]);
        expect(await lines("ssh-calls")).toEqual([]);
    });

    it("removes the record an interrupted attempt left of this server, then adds it", async () => {
        await writeFile(join(bin, "mode"), "stale");
        const clusterId = await createCluster();

        sidecar.machines.push({ id: "machine-ghost", name: "ghost", state: "Down" });
        await prepare(clusterId);

        const { deployment } = await attempt(clusterId);
        const calls = await lines("calls");

        expect(deployment.status).toBe("ready");
        expect(calls.filter((line) => line.startsWith("machine add"))).toHaveLength(2);
        expect(calls).toContainEqual(
            expect.stringMatching(/^machine rm machine-ghost --no-reset --yes /),
        );
    });

    it("leaves a name another machine uses for the admin to change", async () => {
        const clusterId = await createCluster();

        sidecar.machines.push({ id: OLD_WORKER, name: "worker", state: "Up" });
        await prepare(clusterId, PUBLIC_HOST, "worker");

        const { deployment } = await attempt(clusterId);

        expect(deployment.error).toBe(
            "This cluster already has a machine named worker. Discard this server and add it again with another name.",
        );
        expect(await lines("calls")).toEqual([]);
    });

    it("keeps uc's reason when the relay to the sidecar also failed", async () => {
        await writeFile(join(bin, "mode"), "member");
        relayError = new Error("bad upgrade (503)");
        const clusterId = await createCluster();

        await prepare(clusterId);

        const { deployment } = await attempt(clusterId);

        expect(deployment.error).toMatch(
            /^This server already belongs to another Uncloud cluster/u,
        );
        expect(deployment.error).toContain(
            "(uc's connection through the sidecar also failed: bad upgrade (503))",
        );
    });

    it("points the cluster's reserved domain at a new public machine", async () => {
        const clusterId = await createCluster();

        sidecar.domain = { domain: "abc123.uncld.dev", reserved: true };
        sidecar.machines[0]!.publicIp = "93.184.216.30";
        sidecar.added.publicIp = PUBLIC_HOST;
        await prepare(clusterId);

        const { deployment } = await attempt(clusterId);

        expect(deployment.status).toBe("ready");
        expect(sidecar.pointed).toBe(1);
        expect((await logs(deployment.id)).map(({ text }) => text)).toContain(
            `abc123.uncld.dev points at 93.184.216.30, ${PUBLIC_HOST}.`,
        );
    });

    it("adds a public machine even when the domain can't point at it", async () => {
        const clusterId = await createCluster();

        sidecar.domain = { domain: "abc123.uncld.dev", reserved: true };
        sidecar.records = {
            status: 422,
            error: "no machine running Caddy answered on its public IP",
        };
        sidecar.added.publicIp = PUBLIC_HOST;
        await prepare(clusterId);

        const { deployment } = await attempt(clusterId);

        expect(deployment.status).toBe("ready");
        expect((await logs(deployment.id)).map(({ text }) => text)).toContain(
            "Stoat couldn't point the cluster's domain at worker: no machine running Caddy answered on its public IP",
        );
    });

    it("leaves an external domain alone, and a machine without a public IP out of the records", async () => {
        const external = await createCluster();

        sidecar.domain = { domain: "apps.example.com", reserved: false };
        sidecar.added.publicIp = PUBLIC_HOST;
        await prepare(external);
        expect((await attempt(external)).deployment.status).toBe("ready");

        await rm(join(bin, "added"));
        sidecar.services = sidecar.services.map((service) => ({
            ...service,
            machines: ["machine-1"],
        }));
        sidecar.domain = { domain: "abc123.uncld.dev", reserved: true };
        delete sidecar.added.publicIp;

        const lan = await createCluster();

        await prepare(lan);
        expect((await attempt(lan)).deployment.status).toBe("ready");
        expect(sidecar.pointed).toBe(0);
    });

    it("explains an outdated sidecar and a rejected key before uc runs", async () => {
        const clusterId = await createCluster();

        await prepare(clusterId);
        sidecar.relay = 404;
        expect((await attempt(clusterId)).deployment.error).toContain("too old to add machines");
        expect(await lines("ssh-calls")).toEqual([]);

        sidecar.relay = 426;
        await writeFile(join(bin, "ssh-mode"), "rejected");
        expect((await attempt(clusterId)).deployment.error).toBe(
            "The server rejected Stoat's key. Add the public key to ~/.ssh/authorized_keys for root, then retry.",
        );
        expect(await lines("calls")).toEqual([]);
    });

    it("never connects to loopback, link-local or reserved addresses", async () => {
        const clusterId = await createCluster();

        for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "::1"])
            await expect(prepare(clusterId, host)).rejects.toThrow(
                "Stoat doesn't connect to loopback",
            );

        // A hostname is only resolved by the worker, so it refuses one that points at loopback.
        await prepare(clusterId);
        await db
            .update(clusters)
            .set({
                pendingMachine: sql`jsonb_set(${clusters.pendingMachine}, '{host}', '"localhost"')`,
            })
            .where(eq(clusters.id, clusterId));

        const { deployment } = await attempt(clusterId);

        expect(deployment.error).toContain("doesn't connect to localhost");
        expect(await lines("ssh-calls")).toEqual([]);
    });

    it("rejects machine names Uncloud won't take", async () => {
        const clusterId = await createCluster();

        for (const name of [
            "bad_name",
            "-edge",
            "nearest",
            "rr",
            "c337f00600de51ef4375c9a9a267dba5",
            "a".repeat(64),
        ])
            await expect(prepare(clusterId, PUBLIC_HOST, name), name).rejects.toThrow();

        await expect(
            call(
                clusterRouter.prepareMachine,
                { clusterId, host: PUBLIC_HOST, user: "-oProxyCommand=x" },
                { context },
            ),
        ).rejects.toThrow();
    });

    it("takes one server at a time, and one attempt at a time", async () => {
        const clusterId = await createCluster();

        await expect(start(clusterId)).rejects.toThrow("No server is waiting");
        await prepare(clusterId);
        await expect(prepare(clusterId)).rejects.toThrow("Finish or discard the server");

        const deploymentId = await start(clusterId);

        await expect(start(clusterId)).rejects.toThrow("A machine is being added");
        await expect(
            call(clusterRouter.discardPendingMachine, { clusterId }, { context }),
        ).rejects.toThrow("A machine is being added");
        await expect(call(clusterRouter.deleteCluster, { clusterId }, { context })).rejects.toThrow(
            "Wait for the machine being added",
        );

        // Cancelling lets the admin discard the server, which deletes its key.
        await cancelDeployment(db, deploymentId);
        await call(clusterRouter.discardPendingMachine, { clusterId }, { context });

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        expect(cluster).toMatchObject({ pendingMachine: null, pendingMachineKey: null });
    });

    it("never runs an attempt while another one is still stopping", async () => {
        const clusterId = await createCluster();

        await prepare(clusterId);

        const deploymentId = await start(clusterId);
        const other = await db.$client.connect();

        try {
            await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
                `stoat:add-machine:${clusterId}`,
            ]);
            await addMachine(db, deploymentId, new AbortController().signal).catch(() => {});
            await expect(start(clusterId)).rejects.toThrow("still being added or removed");
        } finally {
            other.release(true);
        }

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        expect(deployment).toMatchObject({
            status: "failed",
            error: expect.stringContaining("still stopping"),
        });
        expect(await lines("calls")).toEqual([]);
    });

    it("keeps a server whose attempt was cancelled right before it finished, and retryable", async () => {
        const clusterId = await createCluster(false);

        await prepare(clusterId);

        const deploymentId = await start(clusterId);
        const spreading = fakeClient.stream.spreadService;

        // An admin cancels while Caddy spreads; the job's abort arrives later.
        fakeClient.stream.spreadService = async function* (name: string) {
            if (name === "caddy") await cancelDeployment(db, deploymentId);

            yield* spreading(name);
        };

        try {
            await addMachine(db, deploymentId, new AbortController().signal);
        } finally {
            fakeClient.stream.spreadService = spreading;
        }

        const [cluster] = await db.select().from(clusters).where(eq(clusters.id, clusterId));

        const [deployment] = await db
            .select()
            .from(deployments)
            .where(eq(deployments.id, deploymentId));

        expect(deployment).toMatchObject({ status: "cancelled" });
        expect(cluster!.pendingMachine?.joined).toEqual({ id: "machine-new", name: "worker" });
        expect(cluster!.pendingMachineKey).not.toBeNull();
        expect((await attempt(clusterId)).deployment.status).toBe("ready");
    });

    it("shows a newly prepared server as pending, whatever happened to the last one", async () => {
        const clusterId = await createCluster();

        await prepare(clusterId);
        sidecar.relay = 404;
        expect((await attempt(clusterId)).deployment.status).toBe("failed");
        await call(clusterRouter.discardPendingMachine, { clusterId }, { context });

        await prepare(clusterId);
        expect(
            await call(clusterRouter.getPendingMachine, { clusterId }, { context }),
        ).toMatchObject({
            status: "pending",
            deploymentId: null,
        });
    });

    it("removes machines through the sidecar, and adds again a pending server it removed", async () => {
        const clusterId = await createCluster();

        sidecar.machines.push(
            { id: OLD_WORKER, name: "old-worker", state: "Down" },
            { id: STALE, name: "stale", state: "Up" },
        );
        await prepare(clusterId);
        await setPendingMachineJoined(db, clusterId, { id: STALE, name: "stale" });

        // Another machine leaves the pending server's progress alone.
        expect(await remove(clusterId, OLD_WORKER)).toEqual({ name: "old-worker", reset: false });
        expect(await joined(clusterId)).toEqual({ id: STALE, name: "stale" });

        expect(await remove(clusterId, STALE)).toEqual({ name: "stale", reset: true });
        expect(await joined(clusterId)).toBeNull();
        expect(sidecar.removed).toEqual([OLD_WORKER, STALE]);

        // So a retry runs uc again instead of waiting for a machine that's gone.
        expect((await attempt(clusterId)).deployment.status).toBe("ready");
        expect(await lines("calls")).toContainEqual(expect.stringContaining("machine add"));
    });

    it("explains why the sidecar didn't remove a machine", async () => {
        const clusterId = await createCluster();

        await expect(remove(clusterId, "../cluster/domain")).rejects.toThrow();

        for (const [status, error, message] of [
            [405, "Method Not Allowed", "too old to remove machines"],
            [404, "machine not found", "no longer in the cluster"],
            [422, 'the sidecar reaches Uncloud through machine "edge"', "reaches Uncloud through"],
            [500, "remove containers: container web-1: timed out", "container web-1: timed out"],
        ] as const) {
            sidecar.removal = { status, error };
            await expect(remove(clusterId, OLD_WORKER)).rejects.toThrow(message);
        }

        expect(sidecar.removed).toEqual([]);
    });

    it("adds no machine while one is being removed", async () => {
        const clusterId = await createCluster();

        sidecar.machines.push({ id: OLD_WORKER, name: "old-worker", state: "Up" });
        await prepare(clusterId);

        const deleting = fakeClient.DELETE;
        let refused = "";

        fakeClient.DELETE = async (path, options) => {
            refused = await start(clusterId).then(
                () => "started",
                (error: Error) => error.message,
            );

            return deleting(path, options);
        };

        try {
            await remove(clusterId, OLD_WORKER);
        } finally {
            fakeClient.DELETE = deleting;
        }

        expect(refused).toBe(
            "A machine is still being added or removed. Try again in a few seconds.",
        );
        // Once it's gone, the server can be added.
        expect(await start(clusterId)).toEqual(expect.any(String));
    });

    it("removes no machine while one is being added", async () => {
        const clusterId = await createCluster();

        sidecar.machines.push({ id: OLD_WORKER, name: "old-worker", state: "Up" });
        await prepare(clusterId);
        await start(clusterId);

        await expect(remove(clusterId, OLD_WORKER)).rejects.toThrow("A machine is being added");
        expect(sidecar.removed).toEqual([]);
    });

    it("lets only the cluster's organization admins see or change its pending server", async () => {
        const clusterId = await createCluster();

        sidecar.machines.push({ id: OLD_WORKER, name: "old-worker", state: "Up" });
        await prepare(clusterId);

        for (const caller of [otherContext, memberContext]) {
            await expect(remove(clusterId, OLD_WORKER, caller)).rejects.toThrow();
            await expect(
                call(clusterRouter.getPendingMachine, { clusterId }, { context: caller }),
            ).rejects.toThrow();
            await expect(
                call(clusterRouter.addMachine, { clusterId }, { context: caller }),
            ).rejects.toThrow();
            await expect(
                call(clusterRouter.discardPendingMachine, { clusterId }, { context: caller }),
            ).rejects.toThrow();
            await expect(
                call(
                    clusterRouter.prepareMachine,
                    { clusterId, host: PUBLIC_HOST },
                    { context: caller },
                ),
            ).rejects.toThrow();
        }

        expect(sidecar.removed).toEqual([]);

        const response = JSON.stringify(
            await call(clusterRouter.getPendingMachine, { clusterId }, { context }),
        );

        expect(response).not.toContain("PRIVATE KEY");
        expect(response).not.toContain("enc:v1:");
    });

    it("waits for a cluster's own setup before adding machines to it", async () => {
        const { id: clusterId } = await call(
            clusterRouter.provisionCluster,
            { name: "Fresh", host: PUBLIC_HOST },
            { context },
        );

        await expect(prepare(clusterId)).rejects.toThrow("still being set up");
    });
});
