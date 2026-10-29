import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusters } from "@stoat/db/schema/index";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { clusterRouter } from "../../packages/api/src/routers/cluster";
import { insertUserWithOrganization } from "../users";

describe("cluster domain API", () => {
    const databaseName = `stoat_domain_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let owner: Context;
    let member: Context;
    let outsider: Context;
    let domain: { domain: string; reserved: boolean } | null;
    let requests: string[];

    // Answers like Uncloud: one domain at a time, and DELETE releases a reserved one.
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            requests.push(request.method ?? "");
            response.setHeader("Content-Type", "application/json");

            if (request.method === "PUT") {
                // SAFETY: the router sends the sidecar's SetDomainRequest body.
                const { name } = JSON.parse(Buffer.concat(chunks).toString()) as { name: string };

                if (domain) {
                    response.writeHead(409);
                    response.end(JSON.stringify({ error: "cluster domain already configured" }));

                    return;
                }

                if (name === "busy.example.com") {
                    response.writeHead(412);
                    response.end(JSON.stringify({ error: "cluster is not ready" }));

                    return;
                }

                domain = { domain: name, reserved: false };
            }

            if (request.method === "DELETE") domain = null;

            if (!domain && request.method === "GET") {
                response.writeHead(404);
                response.end(JSON.stringify({ error: "not found" }));

                return;
            }

            response.end(JSON.stringify(domain ?? { status: "cleared" }));
        });
    });

    function sessionContext(userId: string, organizationId: string) {
        // SAFETY: these procedures read only the session identity and active organization.
        return {
            db,
            session: { user: { id: userId }, session: { activeOrganizationId: organizationId } },
        } as Context;
    }

    beforeAll(async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        // SAFETY: listen(0, "127.0.0.1") creates a TCP server, never a Unix socket.
        const { port } = server.address() as AddressInfo;
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(
            db,
            "domain-owner",
            "Owner",
            "owner@example.test",
        );

        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('domain-member', 'Member', 'member@example.test')`,
        );
        await db.$client.query(
            `INSERT INTO member (id, organization_id, user_id, role, created_at)
             VALUES ($1, $2, 'domain-member', 'member', now())`,
            [randomUUID(), organizationId],
        );
        owner = sessionContext("domain-owner", organizationId);
        member = sessionContext("domain-member", organizationId);
        outsider = sessionContext(
            "domain-outsider",
            await insertUserWithOrganization(
                db,
                "domain-outsider",
                "Outsider",
                "outsider@example.test",
            ),
        );
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: `http://127.0.0.1:${port}`,
            sidecarToken: "secret",
            organizationId,
        });
    }, 30_000);

    beforeEach(() => {
        domain = null;
        requests = [];
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    const read = (context = owner) => call(clusterRouter.getDomain, { clusterId }, { context });

    it("sets a domain on a cluster without one, then replaces it", async () => {
        expect(await read()).toEqual({ domain: null, reserved: false, canManage: true });

        await call(
            clusterRouter.setDomain,
            { clusterId, domain: " Apps.Example.com. " },
            {
                context: owner,
            },
        );

        expect(await read()).toEqual({
            domain: "apps.example.com",
            reserved: false,
            canManage: true,
        });

        requests = [];
        await call(
            clusterRouter.setDomain,
            { clusterId, domain: "other.example.com" },
            {
                context: owner,
            },
        );

        expect(domain).toEqual({ domain: "other.example.com", reserved: false });
        expect(requests).toEqual(["GET", "DELETE", "PUT"]);

        requests = [];
        await call(
            clusterRouter.setDomain,
            { clusterId, domain: "other.example.com" },
            {
                context: owner,
            },
        );
        await call(clusterRouter.clearDomain, { clusterId }, { context: owner });

        expect(requests).toEqual(["GET", "GET", "DELETE"]);
        expect(await read()).toMatchObject({ domain: null });
    });

    it("only releases a uncld.dev domain once the user confirms", async () => {
        domain = { domain: "x9tx94.uncld.dev", reserved: true };

        await expect(
            call(
                clusterRouter.setDomain,
                { clusterId, domain: "apps.example.com" },
                {
                    context: owner,
                },
            ),
        ).rejects.toThrow("Confirm releasing x9tx94.uncld.dev");
        await expect(
            call(clusterRouter.clearDomain, { clusterId }, { context: owner }),
        ).rejects.toThrow("Confirm releasing");
        expect(requests).not.toContain("DELETE");

        await call(
            clusterRouter.setDomain,
            { clusterId, domain: "apps.example.com", release: true },
            { context: owner },
        );

        expect(domain).toEqual({ domain: "apps.example.com", reserved: false });
    });

    it("refuses names Uncloud can't use and shows its own reasons", async () => {
        for (const name of ["*.example.com", "localhost", "apps..example.com", "-apps.example.com"])
            await expect(
                call(clusterRouter.setDomain, { clusterId, domain: name }, { context: owner }),
            ).rejects.toThrow("Input validation failed");

        expect(requests).toEqual([]);

        await expect(
            call(
                clusterRouter.setDomain,
                { clusterId, domain: "busy.example.com" },
                {
                    context: owner,
                },
            ),
        ).rejects.toThrow("cluster is not ready");
    });

    it("lets members read the domain, and keeps other organizations out", async () => {
        domain = { domain: "apps.example.com", reserved: false };

        expect(await read(member)).toEqual({
            domain: "apps.example.com",
            reserved: false,
            canManage: false,
        });
        await expect(
            call(clusterRouter.clearDomain, { clusterId }, { context: member }),
        ).rejects.toThrow("owner or admin");
        await expect(read(outsider)).rejects.toThrow("Cluster not found");
        expect(domain).toEqual({ domain: "apps.example.com", reserved: false });
    });
});
