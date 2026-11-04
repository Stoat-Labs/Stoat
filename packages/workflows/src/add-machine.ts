import type { Database } from "@stoat/db";
import {
    finishAddingMachine,
    markPendingMachineJoining,
    setPendingMachineJoined,
} from "@stoat/db/clusters";
import { appendDeploymentLog, setDeploymentStatus } from "@stoat/db/deployments";
import type { PendingMachine } from "@stoat/db/schema/index";
import { serveUncloudSocket, UcApiError, ucClient, unwrap, type UcClient } from "@stoat/uncloud";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { followDeployment } from "./deploy-compose";
import { bounded, machinesWithoutGeoip } from "./initialize-cluster";
import { ALLOY_SERVICE } from "./monitoring-compose";
import { isPrivateServerAddress } from "./server-address";
import {
    createWorkspace,
    machineState,
    runUc,
    serverAddress,
    sshDestination,
    sshFailure,
    ucVersion,
    type Log,
    type Server,
    type Workspace,
} from "./ssh-setup";

type Machine = NonNullable<PendingMachine["joined"]>;

type Cluster = {
    id: string;
    sidecarUrl: string;
    sidecarToken: string;
    sidecarCertificate: string | null;
};

// The global services Stoat itself runs on every machine.
const SIDECAR_SERVICE = "sidecar";

const CADDY_SERVICE = "caddy";

// Like uc, which gives a new machine five minutes to join.
const JOIN_TIMEOUT = 5 * 60_000;

const ALREADY_MEMBER =
    "This server already belongs to another Uncloud cluster. Remove it from that cluster or run uncloud-uninstall on it, then retry.";

/** The advisory lock an attempt holds while it runs, so machines join a cluster one at a time. */
export function addMachineLock(clusterId: string) {
    return `stoat:add-machine:${clusterId}`;
}

async function listMachines(uc: UcClient, signal: AbortSignal) {
    const { items } = await unwrap(uc.GET("/api/v1/machines", { signal: bounded(signal, 30_000) }));

    return items;
}

/** The newest daemon version in the cluster, so the new machine doesn't drift from the rest. */
export function clusterVersion(machines: { daemonVersion?: string }[]) {
    const versions = machines.flatMap(({ daemonVersion = "" }) =>
        /^v?\d+\.\d+\.\d+$/.test(daemonVersion) ? [daemonVersion.replace(/^v/, "")] : [],
    );

    return versions.sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0] ?? null;
}

// Sidecars from before Stoat added machines can't relay uc, so check before touching the server.
async function checkRelay(uc: UcClient, signal: AbortSignal) {
    const { response } = await uc
        .GET("/api/v1/cluster/connect", { signal: bounded(signal, 30_000) })
        .catch((error: Error) => {
            if (signal.aborted) throw error;

            throw new Error(`Stoat couldn't reach the cluster's sidecar at ${uc.baseUrl}.`);
        });

    if (response.status === 426) return;

    if (response.status === 404)
        throw new Error(
            "This cluster's sidecar is too old to add machines. Update the Stoat sidecar, then retry.",
        );

    if (response.status === 501)
        throw new Error(
            "This cluster's sidecar reaches Uncloud over SSH, so Stoat can't add machines through it.",
        );

    throw new Error(
        `The cluster's sidecar answered ${response.status} when Stoat checked its relay to Uncloud.`,
    );
}

// Turns uc's errors into something the user can act on.
function addFailure(message: string, user: string) {
    if (message.includes("already initialised")) return ALREADY_MEMBER;

    return sshFailure(message, user);
}

/** Installs Uncloud on the server and adds it to the cluster with uc, which reaches the cluster through the sidecar. */
async function joinCluster(
    db: Database,
    cluster: Cluster,
    pending: PendingMachine,
    key: string,
    uc: UcClient,
    workspace: Workspace,
    log: Log,
    signal: AbortSignal,
): Promise<Machine> {
    const server: Server = { ...pending, host: await serverAddress(pending.host) };

    await checkRelay(uc, signal);
    await writeFile(workspace.key, key, { mode: 0o600 });

    const before = await listMachines(uc, signal);

    log(`Checking ${server.host} for an existing Uncloud cluster...`);

    const remote = await machineState(server, workspace, signal).catch((error: Error) => {
        if (signal.aborted) throw error;

        throw new Error(sshFailure(error.message, server.user));
    });

    if (remote.id !== null) {
        const member = before.find((machine) => machine.id === remote.id);

        if (!member) throw new Error(ALREADY_MEMBER);

        // Only an earlier attempt that ran uc can have added it; otherwise it was a machine already.
        if (!pending.joining)
            throw new Error(
                `${server.host} is already ${member.name} in this cluster. Discard it and add another server.`,
            );

        log(`${server.host} already joined the cluster as ${member.name}.`);

        return { id: member.id, name: member.name };
    }

    // uc registers the server's key before it joins, so an interrupted attempt leaves a Down record of it.
    const stale =
        remote.publicKey === null
            ? undefined
            : before.find(
                  ({ state, network }) =>
                      state === "Down" && network?.publicKey === remote.publicKey,
              );

    // Uncloud refuses a taken name, so say so before uc installs anything.
    if (pending.name && before.some(({ id, name }) => name === pending.name && id !== stale?.id))
        throw new Error(
            `This cluster already has a machine named ${pending.name}. Discard this server and add it again with another name.`,
        );

    // It would refuse the server's name and key, and it never ran anything, so no reset.
    if (stale) {
        log(`Removing ${stale.name}, which an earlier attempt registered but never finished.`);
        await unwrap(
            uc.DELETE("/api/v1/machines/{id}", {
                params: { path: { id: stale.id } },
                signal: bounded(signal, 120_000),
            }),
        );
    }

    const version = clusterVersion(before) ?? (await ucVersion(workspace, signal));
    const socketPath = join(workspace.dir, "uncloud.sock");

    const args = [
        "machine",
        "add",
        `ssh+go://${sshDestination(server)}`,
        "--ssh-key",
        workspace.key,
        // Stoat spreads Caddy itself: uc's own rollout drops a custom global Caddyfile.
        "--no-caddy",
    ];

    if (version) args.push("--version", version);

    if (pending.name) args.push("--name", pending.name);

    // A private address is no ingress for the cluster's public domain.
    if (isPrivateServerAddress(server.host)) args.push("--public-ip", "none");

    await markPendingMachineJoining(db, cluster.id);

    const socket = await serveUncloudSocket(cluster.sidecarUrl, socketPath, {
        token: cluster.sidecarToken,
        certificate: cluster.sidecarCertificate,
    });

    try {
        await writeFile(
            workspace.config,
            stringify({
                current_context: "default",
                contexts: { default: { connections: [{ unix: socketPath }] } },
            }),
            { mode: 0o600 },
        );
        log(
            `Installing Uncloud ${version ?? "(latest)"} on ${server.host} and adding it to the cluster...`,
        );
        await runUc(workspace, args, log, signal);
    } catch (error) {
        if (signal.aborted || !(error instanceof Error)) throw error;

        const failure = addFailure(error.message, server.user);

        // One failed relay needn't be why uc failed, so keep uc's own reason first.
        throw new Error(
            socket.error
                ? `${failure} (uc's connection through the sidecar also failed: ${socket.error.message})`
                : failure,
        );
    } finally {
        await socket.close();
    }

    const added = (await listMachines(uc, signal)).find(
        (machine) =>
            !before.some((known) => known.id === machine.id) &&
            (!pending.name || machine.name === pending.name),
    );

    if (!added) throw new Error("uc added the server, but the cluster doesn't list it. Retry.");

    return { id: added.id, name: added.name };
}

// Up means the cluster reaches the machine over WireGuard, so services can run on it.
async function waitUntilUp(uc: UcClient, machine: Machine, log: Log, signal: AbortSignal) {
    log(`Waiting for ${machine.name} to come up in the cluster...`);

    const deadline = Date.now() + JOIN_TIMEOUT;

    while (Date.now() < deadline) {
        const machines = await listMachines(uc, signal).catch((error: Error) => {
            if (signal.aborted) throw error;

            return [];
        });

        const up = machines.find(({ id, state }) => id === machine.id && state === "Up");

        if (up) return up;
        await delay(5_000, undefined, { signal });
    }

    throw new Error(
        `${machine.name} joined but didn't come up in time. Check that every machine's firewall lets in WireGuard on UDP port 51820 and traffic on its uncloud interface, then retry.`,
    );
}

/** The service, or null when it isn't deployed. */
async function inspectService(uc: UcClient, name: string, signal: AbortSignal) {
    try {
        return await unwrap(
            uc.GET("/api/v1/services/{id}", {
                params: { path: { id: name } },
                signal: bounded(signal, 30_000),
            }),
        );
    } catch (error) {
        if (error instanceof UcApiError && error.status === 404) return null;

        throw error;
    }
}

// Spread events keep their plan and progress tags, which the deployment page builds its steps from.
function follow(uc: UcClient, name: string, log: Log, signal: AbortSignal) {
    return followDeployment(
        uc.stream.spreadService(name, { signal }),
        signal,
        async (text, level, event) => log(text, level === "error" ? "error" : "info", event),
    );
}

/** Starts a global service on the new machine with its current spec, retrying until the container is there. */
async function spreadService(
    uc: UcClient,
    name: string,
    machine: Machine,
    log: Log,
    signal: AbortSignal,
) {
    for (let attempt = 1; ; attempt++) {
        await follow(uc, name, log, signal);

        const service = await inspectService(uc, name, signal);

        if (service?.containers.some(({ machineId }) => machineId === machine.id)) return;

        if (attempt === 3) throw new Error(`${name} didn't start on ${machine.name}.`);
        await delay(10_000, undefined, { signal });
    }
}

/** Like uc after its Caddy rollout: points the domain reserved in Uncloud DNS at the machines whose Caddy answers. */
async function pointDomain(uc: UcClient, machine: Machine, log: Log, signal: AbortSignal) {
    try {
        const { data: domain } = await uc.GET("/api/v1/cluster/domain", {
            signal: bounded(signal, 30_000),
        });

        // An external domain's records are the user's, and without a domain there are none.
        if (!domain?.reserved) return;

        log(`Pointing ${domain.domain} at ${machine.name} too...`);

        const { records } = await unwrap(
            uc.PUT("/api/v1/cluster/domain/records", { signal: bounded(signal, 60_000) }),
        );

        log(`${domain.domain} points at ${records.flatMap(({ values }) => values).join(", ")}.`);
    } catch (error) {
        if (signal.aborted || !(error instanceof Error)) throw error;

        // The machine already runs everything, so its missing record doesn't fail the attempt.
        log(`Stoat couldn't point the cluster's domain at ${machine.name}: ${error.message}`);
    }
}

/** Runs the cluster's own global services on the new machine, which Uncloud leaves to whoever deploys them. */
async function spreadServices(
    uc: UcClient,
    machine: Machine & { publicIp?: string },
    monitored: boolean,
    log: Log,
    signal: AbortSignal,
) {
    log(`Starting the Stoat sidecar on ${machine.name}...`);
    await spreadService(uc, SIDECAR_SERVICE, machine, log, signal);

    if (await inspectService(uc, CADDY_SERVICE, signal)) {
        log(`Starting Caddy on ${machine.name}...`);
        // Caddy's placement may leave the machine out, so its container isn't required.
        await follow(uc, CADDY_SERVICE, log, signal);

        const caddy = await inspectService(uc, CADDY_SERVICE, signal);

        // A private machine, or one without Caddy, is no ingress for the cluster's domain.
        if (machine.publicIp && caddy?.containers.some(({ machineId }) => machineId === machine.id))
            await pointDomain(uc, machine, log, signal);
    }

    if (monitored && (await inspectService(uc, ALLOY_SERVICE, signal))) {
        if ((await machinesWithoutGeoip(uc, [machine], bounded(signal, 60_000))).length)
            throw new Error(
                `${machine.name} has no GeoIP database, which Alloy needs. Update the Stoat sidecar, then retry.`,
            );

        log(`Starting the monitoring collector on ${machine.name}...`);
        await spreadService(uc, ALLOY_SERVICE, machine, log, signal);
    }

    const { items } = await unwrap(uc.GET("/api/v1/services", { signal: bounded(signal, 30_000) }));

    const missing = items.flatMap((service) =>
        service.mode === "global" &&
        ![SIDECAR_SERVICE, CADDY_SERVICE, ALLOY_SERVICE].includes(service.name) &&
        !service.containers.some(({ machineId }) => machineId === machine.id)
            ? [service.name]
            : [],
    );

    // Placement may keep some of them off the machine on purpose.
    if (missing.length)
        log(
            `Global services not on ${machine.name} yet: ${missing.join(", ")}. Redeploy any that should run there.`,
        );
}

/** Runs one attempt to add the cluster's pending machine, the `AddMachine` deployment `deploymentId`. */
export async function addMachine(db: Database, deploymentId: string, signal: AbortSignal) {
    const claimed = await db.$client.query<{ clusterId: string }>(
        `UPDATE deployments SET status = 'running', error = NULL, finished_at = NULL, updated_at = now()
         WHERE id = $1 AND name = 'AddMachine' AND status IN ('queued', 'running')
         RETURNING cluster_id AS "clusterId"`,
        [deploymentId],
    );

    // Cancelled, settled or deleted since it was queued.
    const clusterId = claimed.rows[0]?.clusterId;

    if (!clusterId) return;

    // Lines are written in order without holding up uc's output.
    let pending = Promise.resolve();

    const log: Log = (text, level = "info", event) => {
        pending = pending.then(() =>
            appendDeploymentLog(db, deploymentId, text, { level, ...(event && { event }) }).catch(
                () => {},
            ),
        );
    };

    const workspace = await createWorkspace("stoat-machine-");
    const lock = await db.$client.connect();
    let acquired = false;

    try {
        const result = await lock.query<{ acquired: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
            [addMachineLock(clusterId)],
        );

        acquired = result.rows[0]?.acquired === true;

        // A cancelled attempt keeps going until its worker's next heartbeat.
        if (!acquired)
            throw new Error("An earlier attempt is still stopping. Retry in a few seconds.");

        const cluster = await db.query.clusters.findFirst({
            where: { id: clusterId },
        });

        if (!cluster?.pendingMachine || !cluster.pendingMachineKey)
            throw new Error(
                "No server is waiting to be added. Add it again from the cluster page.",
            );

        const uc = ucClient(cluster.sidecarUrl, {
            token: cluster.sidecarToken,
            certificate: cluster.sidecarCertificate,
        });

        const joined = cluster.pendingMachine.joined;

        let machine =
            joined && (await listMachines(uc, signal)).some(({ id }) => id === joined.id)
                ? joined
                : null;

        // Removed since an earlier attempt added it, so it joins again.
        if (joined && !machine) log(`${joined.name} is no longer in the cluster.`);

        if (!machine) {
            machine = await joinCluster(
                db,
                cluster,
                cluster.pendingMachine,
                cluster.pendingMachineKey,
                uc,
                workspace,
                log,
                signal,
            );
            await setPendingMachineJoined(db, clusterId, machine);
        }

        const member = await waitUntilUp(uc, machine, log, signal);
        await spreadServices(
            uc,
            { ...machine, publicIp: member.publicIp },
            cluster.initializedAt !== null,
            log,
            signal,
        );

        log(`${machine.name} is part of the cluster.`);
        await pending;

        if (!(await finishAddingMachine(db, clusterId, deploymentId)))
            log("Adding the machine was cancelled before Stoat saved it. Retry to finish.");
    } catch (error) {
        // Interruption is not a failure: the job is released and runs again.
        if (signal.aborted) throw error;

        const message = error instanceof Error ? error.message : "Adding the machine failed.";
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
                    addMachineLock(clusterId),
                ]);
        } finally {
            lock.release();
        }
    }
}
