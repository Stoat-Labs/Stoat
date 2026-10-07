import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusters, deployments, projects, resources } from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { postgresService } from "../../packages/api/src/compose";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";

const draft = "# Database\nservices:\n  db:\n    image: postgres:18\n";

function published(port: number) {
    return `${draft}    x-ports: ['${port}:5432/tcp@host']\n`;
}

describe("external connection API", () => {
    const databaseName = `stoat_connections_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    let organizationId: string;
    let failSidecar = false;
    let sidecarRequests = 0;
    const server = createServer((request, response) => {
        sidecarRequests++;
        response.setHeader("Content-Type", "application/json");
        if (failSidecar) {
            response.writeHead(503);
            response.end(JSON.stringify({ error: "offline" }));
            return;
        }
        if (request.url === "/api/v1/machines") {
            response.end(JSON.stringify({ items: [{ id: "machine", publicIp: "203.0.113.10" }] }));
            return;
        }
        response.end(
            JSON.stringify({
                items: [
                    {
                        id: "live",
                        name: "live",
                        mode: "replicated",
                        hookContainers: [],
                        containers: [
                            {
                                machineId: "machine",
                                machineName: "machine",
                                container: {
                                    Config: {
                                        Labels: { "uncloud.service.ports": "15435:5432/tcp@host" },
                                    },
                                },
                            },
                        ],
                    },
                ],
            }),
        );
    });

    beforeAll(async () => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || address instanceof String) throw new Error("Missing server address");
        // SAFETY: listen(0, '127.0.0.1') creates a TCP server, never a Unix socket.
        const port = (address as import("node:net").AddressInfo).port;
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('connections', 'Connections', 'connections@example.test')`,
        );
        const membership = await db.$client.query(
            `SELECT organization_id FROM member WHERE user_id = 'connections'`,
        );
        organizationId = membership.rows[0].organization_id;
        // SAFETY: these procedures only read the session identity and organization.
        context = {
            db,
            session: {
                user: { id: "connections" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values({
            id: clusterId,
            name: "Cluster",
            sidecarUrl: `http://127.0.0.1:${port}`,
            sidecarToken: "secret",
            organizationId,
        });
        await db.insert(projects).values({ id: projectId, name: "Project", clusterId });
    }, 30_000);

    beforeEach(async () => {
        failSidecar = false;
        sidecarRequests = 0;
        await db.delete(deployments);
        await db.delete(resources);
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

    async function resource(draftSpec = draft, spec: string | null = null) {
        const resourceId = randomUUID();
        await db.insert(resources).values({
            id: resourceId,
            projectId,
            name: "Postgres",
            type: "database",
            settings: { engine: "postgresql" },
            draftSpec,
            spec,
        });
        return { clusterId, projectId, resourceId, expectedSpec: draftSpec, expectedSource: null };
    }

    it("avoids draft, deployed, queued and live ports, saves only the draft, and reports pending deployment", async () => {
        await resource(published(15432), published(15433));
        const input = await resource(draft, draft);
        const deploymentId = randomUUID();
        await db.insert(deployments).values({
            id: deploymentId,
            jobId: deploymentId,
            clusterId,
            resourceId: input.resourceId,
            name: "DeployResource",
            status: "queued",
            spec: published(15434),
        });
        const updated = await call(resourcesRouter.enableExternalConnection, input, { context });
        expect(updated.spec).toBe(draft);
        expect(updated.draftSpec).toContain("# Database");
        expect(postgresService(updated.draftSpec!)?.published?.port).toBe(15436);
        expect(await db.select().from(deployments)).toHaveLength(1);
        expect(await call(resourcesRouter.getConnection, input, { context })).toMatchObject({
            externalPort: 15436,
            pendingDeployment: true,
            external: "postgresql://postgres:@203.0.113.10:15436/postgres",
        });
        await db
            .update(resources)
            .set({ spec: updated.draftSpec })
            .where(eq(resources.id, input.resourceId));
        expect(await call(resourcesRouter.getConnection, input, { context })).toMatchObject({
            pendingDeployment: false,
        });
        const again = await call(
            resourcesRouter.enableExternalConnection,
            { ...input, expectedSpec: updated.draftSpec },
            { context },
        );
        expect(again.draftSpec).toBe(updated.draftSpec);
    });

    it("only warns about an external port that has not been deployed", async () => {
        const internalOnly = await resource();
        expect(await call(resourcesRouter.getConnection, internalOnly, { context })).toMatchObject({
            externalPort: null,
            pendingDeployment: false,
        });
        const unrelatedEdit = await resource(
            `${published(15432)}# unrelated edit\n`,
            published(15432),
        );
        expect(await call(resourcesRouter.getConnection, unrelatedEdit, { context })).toMatchObject(
            { externalPort: 15432, pendingDeployment: false },
        );
        const changedPort = await resource(published(15433), published(15432));
        expect(await call(resourcesRouter.getConnection, changedPort, { context })).toMatchObject({
            pendingDeployment: true,
        });
    });

    it("allocates different ports for simultaneous requests in the same cluster", async () => {
        const first = await resource();
        const second = await resource();
        const results = await Promise.all([
            call(resourcesRouter.enableExternalConnection, first, { context }),
            call(resourcesRouter.enableExternalConnection, second, { context }),
        ]);
        expect(
            new Set(results.map((row) => postgresService(row.draftSpec!)?.published?.port)).size,
        ).toBe(2);
    });

    it("rejects stale drafts without changing the saved text", async () => {
        const input = await resource();
        await expect(
            call(
                resourcesRouter.enableExternalConnection,
                { ...input, expectedSpec: "old" },
                { context },
            ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(sidecarRequests).toBe(0);
        const [saved] = await db.select().from(resources).where(eq(resources.id, input.resourceId));
        expect(saved.draftSpec).toBe(draft);
    });

    it("does not choose a port if the sidecar is unavailable", async () => {
        const input = await resource();
        failSidecar = true;
        await expect(
            call(resourcesRouter.enableExternalConnection, input, { context }),
        ).rejects.toThrow();
        const [saved] = await db.select().from(resources).where(eq(resources.id, input.resourceId));
        expect(saved.draftSpec).toBe(draft);
    });

    it("rejects mismatched clusters, internal resources and non-PostgreSQL resources", async () => {
        const input = await resource();
        const otherCluster = randomUUID();
        await db.insert(clusters).values({
            id: otherCluster,
            name: "Other",
            organizationId,
            sidecarUrl: "http://unreachable.test",
            sidecarToken: "secret",
        });
        await expect(
            call(
                resourcesRouter.enableExternalConnection,
                { ...input, clusterId: otherCluster },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await db.update(projects).set({ isInternal: true }).where(eq(projects.id, projectId));
        await expect(
            call(resourcesRouter.enableExternalConnection, input, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await db.update(projects).set({ isInternal: false }).where(eq(projects.id, projectId));
        await db
            .update(resources)
            .set({ settings: { engine: "mongodb" } })
            .where(eq(resources.id, input.resourceId));
        await expect(
            call(resourcesRouter.enableExternalConnection, input, { context }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await call(resourcesRouter.getConnection, input, { context })).toBeNull();
        expect(sidecarRequests).toBe(0);
    });

    it("edits database resources like Compose resources and keeps their engine", async () => {
        const { projectId, resourceId } = await resource();

        await call(
            resourcesRouter.updateVariables,
            { projectId, resourceId, env: "POSTGRES_DB=app\n" },
            { context },
        );
        await call(
            resourcesRouter.updateSettings,
            { projectId, resourceId, prefixNames: false },
            { context },
        );
        const updated = await call(
            resourcesRouter.updateDetails,
            { projectId, resourceId, name: "Main database" },
            { context },
        );

        expect(updated).toMatchObject({
            name: "Main database",
            type: "database",
            settings: { engine: "postgresql", env: "POSTGRES_DB=app\n", prefixNames: false },
        });
    });
});
