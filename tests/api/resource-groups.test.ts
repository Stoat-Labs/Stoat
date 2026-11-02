import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@stoat/db";
import { clusters, projects, resourceGroups, resources } from "@stoat/db/schema/index";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

describe("resource groups API (PostgreSQL)", () => {
    const databaseName = `stoat_groups_api_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const foreignClusterId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const internalProjectId = randomUUID();
    const foreignProjectId = randomUUID();
    const apiId = randomUUID();
    const workerId = randomUUID();
    const elsewhereId = randomUUID();
    const internalId = randomUUID();
    const foreignId = randomUUID();
    const spec = "services:\n  app:\n    image: app\n";

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;

    const groupOf = async (id: string) =>
        (await db.select().from(resources).where(eq(resources.id, id)))[0]?.groupId ?? null;

    const create = (resourceIds: string[], project = projectId) =>
        call(
            resourcesRouter.createGroup,
            { projectId: project, name: "Backend", resourceIds },
            { context },
        );

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(
            db,
            "owner",
            "Owner",
            "owner@example.test",
        );

        const foreignOrganizationId = await insertUserWithOrganization(
            db,
            "stranger",
            "Stranger",
            "stranger@example.test",
        );

        // SAFETY: these procedures read only identity and active organization from the session.
        context = {
            db,
            session: { user: { id: "owner" }, session: { activeOrganizationId: organizationId } },
        } as Context;

        const sidecar = { sidecarUrl: "http://127.0.0.1:9", sidecarToken: "t" };
        await db.insert(clusters).values([
            { id: clusterId, name: "Main", organizationId, ...sidecar },
            {
                id: foreignClusterId,
                name: "Foreign",
                organizationId: foreignOrganizationId,
                ...sidecar,
            },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Shop" },
            { id: otherProjectId, clusterId, name: "Jobs" },
            { id: internalProjectId, clusterId, name: "Internal", isInternal: true },
            { id: foreignProjectId, clusterId: foreignClusterId, name: "Foreign" },
        ]);
        await db.insert(resources).values([
            { id: apiId, projectId, name: "api", draftSpec: spec },
            { id: workerId, projectId, name: "worker", draftSpec: spec },
            { id: elsewhereId, projectId: otherProjectId, name: "elsewhere", draftSpec: spec },
            { id: internalId, projectId: internalProjectId, name: "internal", draftSpec: spec },
            { id: foreignId, projectId: foreignProjectId, name: "foreign", draftSpec: spec },
        ]);
    });

    beforeEach(async () => {
        await db.delete(resourceGroups);
    });

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    it("creates a group around resources and lists it with them", async () => {
        const group = await create([apiId, workerId]);

        expect(await groupOf(apiId)).toBe(group.id);
        expect(await groupOf(workerId)).toBe(group.id);

        const listed = await call(resourcesRouter.listResources, { projectId }, { context });

        expect(listed.map((resource) => resource.groupId)).toEqual([group.id, group.id]);
        expect(await call(resourcesRouter.listGroups, { projectId }, { context })).toEqual([
            { id: group.id, projectId, name: "Backend", icon: null },
        ]);
    });

    it("refuses resources of another project, and creates nothing then", async () => {
        await expect(create([apiId, elsewhereId])).rejects.toMatchObject({ code: "NOT_FOUND" });

        expect(await groupOf(apiId)).toBeNull();
        expect(await db.select().from(resourceGroups)).toEqual([]);
    });

    it.each([
        ["an internal", internalProjectId, internalId],
        ["another organization's", foreignProjectId, foreignId],
    ])("refuses %s project", async (_, project, resourceId) => {
        await expect(create([resourceId], project)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
            call(resourcesRouter.listGroups, { projectId: foreignProjectId }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("moves a resource between groups and deletes the group it left empty", async () => {
        const first = await create([apiId]);
        const second = await create([workerId]);

        await call(
            resourcesRouter.setGroup,
            { projectId, resourceId: apiId, groupId: second.id },
            { context },
        );

        expect(await groupOf(apiId)).toBe(second.id);
        expect(
            await db.select().from(resourceGroups).where(eq(resourceGroups.id, first.id)),
        ).toEqual([]);

        await call(
            resourcesRouter.setGroup,
            { projectId, resourceId: apiId, groupId: null },
            { context },
        );

        expect(await groupOf(apiId)).toBeNull();
        expect(await groupOf(workerId)).toBe(second.id);
    });

    it("never puts a resource into another project's group", async () => {
        const [group] = await db
            .insert(resourceGroups)
            .values({ id: randomUUID(), projectId: otherProjectId, name: "Jobs" })
            .returning();

        await expect(
            call(
                resourcesRouter.setGroup,
                { projectId, resourceId: apiId, groupId: group!.id },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await groupOf(apiId)).toBeNull();
    });

    it("renames a group and removes it without touching its resources", async () => {
        const group = await create([apiId, workerId]);

        await call(
            resourcesRouter.updateGroup,
            { projectId, groupId: group.id, name: "Shop", icon: "https://example.com/a.svg" },
            { context },
        );

        expect(await call(resourcesRouter.listGroups, { projectId }, { context })).toEqual([
            { id: group.id, projectId, name: "Shop", icon: "https://example.com/a.svg" },
        ]);

        await call(resourcesRouter.deleteGroup, { projectId, groupId: group.id }, { context });

        const rows = await db
            .select({ id: resources.id, groupId: resources.groupId })
            .from(resources)
            .where(inArray(resources.id, [apiId, workerId]));

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.groupId === null)).toBe(true);
    });

    it("deletes the group when its last resource is deleted", async () => {
        const doomedId = randomUUID();

        await db
            .insert(resources)
            .values({ id: doomedId, projectId, name: "doomed", draftSpec: spec });

        const group = await create([doomedId]);

        await call(
            resourcesRouter.deleteResource,
            { projectId, resourceIds: [doomedId] },
            { context },
        );

        expect(
            await db.select().from(resourceGroups).where(eq(resourceGroups.id, group.id)),
        ).toEqual([]);
    });

    it("drops the group when its resource moves to another project", async () => {
        const group = await create([apiId]);

        await call(
            resourcesRouter.moveResource,
            { projectId, resourceId: apiId, toProjectId: otherProjectId },
            { context },
        );

        expect(await groupOf(apiId)).toBeNull();
        expect(
            await db.select().from(resourceGroups).where(eq(resourceGroups.id, group.id)),
        ).toEqual([]);

        await call(
            resourcesRouter.moveResource,
            { projectId: otherProjectId, resourceId: apiId, toProjectId: projectId },
            { context },
        );
    });
});
