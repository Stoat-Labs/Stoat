import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { sidecarFetch, ucClient, unwrap } from "../../packages/uncloud/src/index";

/** A certificate for 127.0.0.1 like the ones Stoat generates for sidecars on a private network. */
async function certificateFor(address: string) {
    return generate([{ name: "commonName", value: address }], {
        keyType: "ec",
        algorithm: "sha256",
        extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: address }] }],
    });
}

let server: Server;

let baseUrl: string;

let pinned: Awaited<ReturnType<typeof certificateFor>>;

const received: { method: string; body: string; authorization: string }[] = [];

beforeAll(async () => {
    pinned = await certificateFor("127.0.0.1");
    server = createServer({ cert: pinned.cert, key: pinned.private }, (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            received.push({
                method: req.method ?? "",
                body: Buffer.concat(chunks).toString("utf8"),
                authorization: req.headers.authorization ?? "",
            });

            if (req.url?.startsWith("/api/v1/services/web/logs")) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end('data: {"message":"hello"}\n\n');

                return;
            }

            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                req.method === "POST"
                    ? JSON.stringify({ exitCode: 0, stdout: "ok", stderr: "" })
                    : JSON.stringify({ items: [] }),
            );
        });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    // SAFETY: listen(0, "127.0.0.1") creates a TCP server, never a Unix socket.
    baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server?.close();
});

describe("sidecars with a pinned certificate", () => {
    it("trusts the pinned certificate for JSON, request bodies and event streams", async () => {
        const uc = ucClient(baseUrl, { token: "pinned-token", certificate: pinned.cert });

        await expect(unwrap(uc.GET("/api/v1/machines"))).resolves.toEqual({ items: [] });
        await expect(
            unwrap(
                uc.POST("/api/v1/machines/{id}/exec", {
                    params: { path: { id: "m1" } },
                    body: { command: ["hostname"] },
                }),
            ),
        ).resolves.toMatchObject({ stdout: "ok" });

        const events = [];

        for await (const event of uc.stream.serviceLogs("web")) events.push(event);

        expect(events).toEqual([{ message: "hello" }]);
        expect(received.at(-2)).toMatchObject({
            method: "POST",
            body: JSON.stringify({ command: ["hostname"] }),
            authorization: "Bearer pinned-token",
        });
    });

    it("lets a fetch wrapper send requests through the pinned transport", async () => {
        const statuses: number[] = [];

        const uc = ucClient(baseUrl, {
            certificate: pinned.cert,
            fetch: async (request) => {
                const response = await sidecarFetch(pinned.cert)(request);
                statuses.push(response.status);

                return response;
            },
        });

        await unwrap(uc.GET("/api/v1/machines"));
        expect(statuses).toEqual([200]);
    });

    it("closes the least recently used pool, and its clients reconnect", async () => {
        const sockets: TLSSocket[] = [];
        const track = (socket: TLSSocket) => sockets.push(socket);

        // Each distinct certificate gets its own pool; trailing newlines keep the PEM valid.
        const certificate = (index: number) => pinned.cert + "\n".repeat(index);

        server.on("secureConnection", track);

        try {
            const first = ucClient(baseUrl, { certificate: certificate(1) });
            await unwrap(first.GET("/api/v1/machines"));

            for (let index = 2; index <= 101; index += 1) {
                const uc = ucClient(baseUrl, { certificate: certificate(index) });
                await unwrap(uc.GET("/api/v1/machines"));
            }

            await vi.waitFor(() => expect(sockets[0]!.closed).toBe(true));
            expect(sockets.at(-1)!.closed).toBe(false);

            await expect(unwrap(first.GET("/api/v1/machines"))).resolves.toEqual({ items: [] });
            expect(sockets).toHaveLength(102);
        } finally {
            server.off("secureConnection", track);
        }
    });

    it("refuses a sidecar that presents any other certificate", async () => {
        const other = await certificateFor("127.0.0.1");

        await expect(
            ucClient(baseUrl, { certificate: other.cert }).GET("/api/v1/machines"),
        ).rejects.toThrow();
        // Without a pin, the self-signed certificate isn't trusted either.
        await expect(ucClient(baseUrl).GET("/api/v1/machines")).rejects.toThrow();
    });
});
