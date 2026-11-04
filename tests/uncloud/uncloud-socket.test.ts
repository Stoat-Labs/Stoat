import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { serveUncloudSocket } from "../../packages/uncloud/src/index";

const token = "relay-token-0123456789";

let server: Server;

let baseUrl: string;

let certificate: string;

let dir: string;

// The upstream side of each relayed connection, like the sidecar's connection to the Uncloud API.
const upstreams: Socket[] = [];

// What the fake sidecar does with an accepted connection: echo by default.
let accepted: (socket: Socket) => void = (socket) => socket.pipe(socket);

// Upgrade requests the fake sidecar received, and what it waits for before switching protocols.
let upgrades = 0;

let switching = Promise.resolve();

beforeAll(async () => {
    const pems = await generate([{ name: "commonName", value: "127.0.0.1" }], {
        keyType: "ec",
        algorithm: "sha256",
        extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });

    certificate = pems.cert;
    server = createServer({ cert: pems.cert, key: pems.private }, (_request, response) => {
        response.writeHead(426, { upgrade: "uncloud", "content-type": "application/json" });
        response.end('{"error":"send Connection: Upgrade and Upgrade: uncloud"}');
    });

    server.on("upgrade", (request, socket: Socket) => {
        if (
            request.url !== "/api/v1/cluster/connect" ||
            request.headers.upgrade !== "uncloud" ||
            request.headers.authorization !== `Bearer ${token}`
        ) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");

            return;
        }

        upgrades++;
        void switching.then(() => {
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: uncloud\r\n\r\n",
            );
            upstreams.push(socket);
            accepted(socket);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: listen(0, "127.0.0.1") creates a TCP server, never a Unix socket.
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "stoat-uncloud-socket-"));
});

afterAll(async () => {
    server?.close();
    await rm(dir, { recursive: true, force: true });
});

async function open(path: string) {
    const client = connect(path);
    await once(client, "connect");

    return client;
}

describe("the Uncloud socket", () => {
    it("relays bytes both ways through the pinned sidecar", async () => {
        const path = join(dir, "echo.sock");
        const relay = await serveUncloudSocket(baseUrl, path, { token, certificate });

        try {
            const client = await open(path);
            const echoed = once(client, "data");

            client.write("ping");
            expect(String((await echoed)[0])).toBe("ping");

            // uc exiting closes its side, which closes the sidecar's.
            const upstream = upstreams.at(-1)!;
            client.destroy();
            await vi.waitFor(() => expect(upstream.destroyed).toBe(true));
            expect(relay.error).toBeNull();
        } finally {
            await relay.close();
        }
    });

    it("hangs up on uc when the sidecar closes", async () => {
        const path = join(dir, "closing.sock");
        const relay = await serveUncloudSocket(baseUrl, path, { token, certificate });

        accepted = (socket) => socket.end();

        try {
            const client = await open(path);

            client.resume();
            await once(client, "close");
        } finally {
            accepted = (socket) => socket.pipe(socket);
            await relay.close();
        }
    });

    it("closes the connection and keeps the reason when the sidecar refuses", async () => {
        const path = join(dir, "refused.sock");

        const relay = await serveUncloudSocket(baseUrl, path, {
            token: "wrong-token",
            certificate,
        });

        try {
            const client = await open(path);

            client.resume();
            await once(client, "close");
            expect(relay.error?.message).toContain("bad upgrade");
        } finally {
            await relay.close();
        }
    });

    it("never trusts a sidecar presenting another certificate", async () => {
        const other = await generate([{ name: "commonName", value: "127.0.0.1" }], {
            keyType: "ec",
            algorithm: "sha256",
        });

        const path = join(dir, "untrusted.sock");
        const relay = await serveUncloudSocket(baseUrl, path, { token, certificate: other.cert });

        try {
            const client = await open(path);

            client.resume();
            await once(client, "close");
            expect(relay.error).not.toBeNull();
        } finally {
            await relay.close();
        }
    });

    it("drops a relay whose upgrade finishes after it was closed", async () => {
        const path = join(dir, "late.sock");
        const relay = await serveUncloudSocket(baseUrl, path, { token, certificate });
        const { promise, resolve } = Promise.withResolvers<void>();

        switching = promise;

        try {
            const requested = upgrades;
            const client = await open(path);

            client.resume();
            await vi.waitFor(() => expect(upgrades).toBe(requested + 1));

            // close() waits for the upgrade in flight, so the sidecar switches only once uc's side closed.
            const count = upstreams.length;
            const closed = relay.close();
            await delay(100);
            resolve();
            await closed;

            await vi.waitFor(() => expect(upstreams.length).toBe(count + 1));
            await vi.waitFor(() => expect(upstreams.at(-1)!.destroyed).toBe(true));
        } finally {
            switching = Promise.resolve();
            resolve();
        }
    });

    it("drops open relays when closed", async () => {
        const path = join(dir, "closed.sock");
        const relay = await serveUncloudSocket(baseUrl, path, { token, certificate });
        const client = await open(path);
        const echoed = once(client, "data");

        client.write("hold");
        await echoed;
        const upstream = upstreams.at(-1)!;

        await relay.close();
        await vi.waitFor(() => expect(client.destroyed && upstream.destroyed).toBe(true));
        await expect(open(path)).rejects.toThrow();
    });
});
