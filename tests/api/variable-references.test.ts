import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import * as runtime from "@stoat/workflows/runtime";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { dropTestDatabase } from "../database";

describe("variable references API (PostgreSQL)", () => {
    const databaseName = `stoat_reference_api_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const otherClusterId = randomUUID();
    const foreignClusterId = randomUUID();
    const projectId = randomUUID();
    const siblingProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const internalProjectId = randomUUID();
    const foreignProjectId = randomUUID();
    const apiId = randomUUID();
    const postgresId = randomUUID();
    const workerId = randomUUID();
    const brokenId = randomUUID();
    const elsewhereId = randomUUID();
    const internalId = randomUUID();
    const foreignId = randomUUID();
    const bucketId = randomUUID();
    const spec = "services:\n  api:\n    image: app\n    environment:\n      URL: ${URL}\n";
    const postgresSpec = "services:\n  db:\n    image: postgres\n";
    const canary = "never-sent-to-the-browser";

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    const enqueue = vi.spyOn(runtime, "queueResourceDeployment").mockResolvedValue();
    const ref = (id: string, key: string) => `{{ ${id}.${key} }}`;
    const deployInput = { projectId, resourceId: apiId };

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES
                ('owner', 'Owner', 'owner@example.test'),
                ('stranger', 'Stranger', 'stranger@example.test')`,
        );

        const memberships = await db.$client.query<{ organization_id: string }>(
            `SELECT organization_id FROM member ORDER BY user_id`,
        );

        const organizationId = memberships.rows[0]!.organization_id;
        const foreignOrganizationId = memberships.rows[1]!.organization_id;
        // SAFETY: these procedures read only identity and active organization from the session.
        context = {
            db,
            session: { user: { id: "owner" }, session: { activeOrganizationId: organizationId } },
        } as Context;
        const sidecar = { sidecarUrl: "http://127.0.0.1:9", sidecarToken: "t" };
        await db.insert(clusters).values([
            { id: clusterId, name: "Main", organizationId, ...sidecar },
            { id: otherClusterId, name: "Other", organizationId, ...sidecar },
            {
                id: foreignClusterId,
                name: "Foreign",
                organizationId: foreignOrganizationId,
                ...sidecar,
            },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Shop" },
            { id: siblingProjectId, clusterId, name: "Jobs" },
            { id: otherProjectId, clusterId: otherClusterId, name: "Elsewhere" },
            { id: internalProjectId, clusterId, name: "Internal", isInternal: true },
            { id: foreignProjectId, clusterId: foreignClusterId, name: "Foreign" },
        ]);

        const secret = { env: `SECRET=${canary}\n` };
        await db.insert(resources).values([
            {
                id: apiId,
                projectId,
                name: "api",
                draftSpec: spec,
                createdAt: new Date("2020-01-01"),
            },
            {
                id: postgresId,
                projectId,
                name: "postgres",
                draftSpec: postgresSpec,
                settings: { env: `POSTGRES_USER=shop\nPOSTGRES_PASSWORD=${canary}\n` },
                createdAt: new Date("2020-01-02"),
            },
            {
                id: workerId,
                projectId: siblingProjectId,
                name: "worker",
                draftSpec: "services:\n  jobs:\n    image: worker\n",
                settings: secret,
            },
            {
                id: brokenId,
                projectId,
                name: "broken",
                draftSpec: "services: [",
                settings: secret,
                createdAt: new Date("2020-01-03"),
            },
            {
                id: elsewhereId,
                projectId: otherProjectId,
                name: "elsewhere",
                draftSpec: postgresSpec,
                settings: secret,
            },
            {
                id: internalId,
                projectId: internalProjectId,
                name: "monitoring",
                draftSpec: postgresSpec,
                settings: secret,
            },
            {
                id: foreignId,
                projectId: foreignProjectId,
                name: "foreign",
                draftSpec: postgresSpec,
                settings: secret,
            },
            { id: bucketId, projectId, name: "assets", type: "bucket", settings: secret },
        ]);
    }, 30_000);

    beforeEach(async () => {
        enqueue.mockClear();
        await db.delete(deployments);
    });

    afterAll(async () => {
        enqueue.mockRestore();
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    async function setApi(env: string, draftSpec = spec) {
        await db
            .update(resources)
            .set({ settings: { env }, draftSpec })
            .where(eq(resources.id, apiId));
    }

    describe("listVariableReferences", () => {
        it("lists same-cluster compose resources, with key names only", async () => {
            const listed = await call(resourcesRouter.listVariableReferences, deployInput, {
                context,
            });

            expect(listed.map((target) => target.name).toSorted()).toEqual([
                "broken",
                "postgres",
                "worker",
            ]);
            expect(listed.find((target) => target.id === postgresId)).toEqual({
                id: postgresId,
                name: "postgres",
                projectId,
                projectName: "Shop",
                keys: [
                    "DB_INTERNAL_HOST",
                    "DB_SERVICE_NAME",
                    "POSTGRES_PASSWORD",
                    "POSTGRES_USER",
                    "STOAT_PREFIX",
                ],
            });
            expect(listed.find((target) => target.id === workerId)).toMatchObject({
                projectId: siblingProjectId,
                projectName: "Jobs",
            });
            expect(JSON.stringify(listed)).not.toContain(canary);
        });

        it("still offers env keys when a resource's Compose cannot be parsed", async () => {
            const listed = await call(resourcesRouter.listVariableReferences, deployInput, {
                context,
            });

            expect(listed.find((target) => target.id === brokenId)?.keys).toEqual(["SECRET"]);
        });

        it("never lists the resource itself", async () => {
            const listed = await call(
                resourcesRouter.listVariableReferences,
                { projectId, resourceId: postgresId },
                { context },
            );

            expect(listed.map((target) => target.id)).toContain(apiId);
            expect(listed.map((target) => target.id)).not.toContain(postgresId);
        });

        it.each([
            ["another organization", () => foreignProjectId],
            ["an internal project", () => internalProjectId],
            ["a missing project", () => randomUUID()],
        ])("refuses %s", async (_, project) => {
            await expect(
                call(
                    resourcesRouter.listVariableReferences,
                    { projectId: project(), resourceId: apiId },
                    { context },
                ),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
        });

        it("refuses callers without an active organization membership", async () => {
            // SAFETY: authorization reads only identity and active organization.
            const stranger = {
                db,
                session: {
                    user: { id: "stranger" },
                    session: {
                        activeOrganizationId: context.session!.session.activeOrganizationId,
                    },
                },
            } as Context;

            await expect(
                call(resourcesRouter.listVariableReferences, deployInput, { context: stranger }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
        });

        it("rejects malformed input", async () => {
            await expect(
                call(
                    resourcesRouter.listVariableReferences,
                    { projectId: "not-a-uuid", resourceId: apiId },
                    { context },
                ),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        });
    });

    describe("deploy", () => {
        it("queues a deployment whose env keeps the references for the worker", async () => {
            const env = `URL=${ref(postgresId, "POSTGRES_USER")}\n`;
            await setApi(env);

            const { id } = await call(resourcesRouter.deploy, deployInput, { context });

            const [input] = await db
                .select()
                .from(resourceDeploymentInputs)
                .where(eq(resourceDeploymentInputs.deploymentId, id));

            expect(input?.env).toBe(env);
            expect(enqueue).toHaveBeenCalledWith(id);
        });

        it("accepts references to other projects and Go templates in Compose", async () => {
            await setApi(
                `URL=${ref(workerId, "SECRET")}\n`,
                `${spec}    command: ["--format", "{{ .Name }}"]\n`,
            );

            await expect(
                call(resourcesRouter.deploy, deployInput, { context }),
            ).resolves.toMatchObject({
                status: "queued",
            });
        });

        it.each([
            [
                "a name instead of an id",
                () => "{{ postgres.POSTGRES_USER }}",
                "Invalid variable reference",
            ],
            [
                "an unknown resource",
                () => ref(randomUUID(), "KEY"),
                "does not exist on this cluster",
            ],
            ["another cluster", () => ref(elsewhereId, "SECRET"), "does not exist on this cluster"],
            [
                "an internal project",
                () => ref(internalId, "SECRET"),
                "does not exist on this cluster",
            ],
            [
                "another organization",
                () => ref(foreignId, "SECRET"),
                "does not exist on this cluster",
            ],
            ["a bucket", () => ref(bucketId, "SECRET"), "does not exist on this cluster"],
            [
                "an unknown key",
                () => ref(postgresId, "NOPE"),
                'Resource "postgres" has no variable NOPE.',
            ],
            [
                "a broken resource",
                () => ref(brokenId, "SECRET"),
                'Unable to read variables from "broken"',
            ],
            ["the resource itself", () => ref(apiId, "URL"), "points at this resource itself"],
        ])("refuses %s before creating a deployment", async (_, value, message) => {
            await setApi(`URL=${value()}\n`);

            await expect(
                call(resourcesRouter.deploy, deployInput, { context }),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: expect.stringContaining(message),
            });
            expect(await db.select().from(deployments)).toEqual([]);
            expect(enqueue).not.toHaveBeenCalled();
        });

        it("refuses references written in Compose", async () => {
            await setApi("", `${spec}      OTHER: "${ref(postgresId, "POSTGRES_USER")}"\n`);

            await expect(
                call(resourcesRouter.deploy, deployInput, { context }),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: expect.stringContaining("not in Compose"),
            });
        });

        it("does not let the referenced resource's domain requirement block the check", async () => {
            await db
                .update(resources)
                .set({ settings: { env: "URL=https://${STOAT_DOMAIN:?needs a domain}\n" } })
                .where(eq(resources.id, workerId));
            await setApi(`URL=${ref(workerId, "URL")}\n`);

            await expect(
                call(resourcesRouter.deploy, deployInput, { context }),
            ).resolves.toMatchObject({
                status: "queued",
            });
        });
    });

    describe("getConnection", () => {
        it("resolves referenced credentials in the connection URL", async () => {
            const databaseId = randomUUID();
            await db.insert(resources).values({
                id: databaseId,
                projectId,
                name: "db",
                type: "database",
                settings: {
                    engine: "postgresql",
                    env: `POSTGRES_USER=${ref(postgresId, "POSTGRES_USER")}\nPOSTGRES_PASSWORD=${ref(postgresId, "POSTGRES_PASSWORD")}\n`,
                },
                draftSpec: "services:\n  postgres:\n    image: postgres:18\n",
            });

            const connection = await call(
                resourcesRouter.getConnection,
                { clusterId, projectId, resourceId: databaseId },
                { context },
            );

            expect(connection?.internal).toBe(
                `postgresql://shop:${canary}@${projectId.slice(0, 8)}-${databaseId.slice(0, 8)}-postgres.internal:5432/shop`,
            );
        });
    });
});
