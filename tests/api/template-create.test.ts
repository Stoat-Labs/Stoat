import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { createDb } from "@clowder/db";
import { clusters, projects, resourceGroups, resources } from "@clowder/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { resourceEnv } from "../../packages/api/src/compose";
import type { Context } from "../../packages/api/src/context";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { summarizeVersion, templates } from "../../packages/api/src/templates";
import {
    composeServiceVariables,
    resourceComposePrefix,
} from "../../packages/workflows/src/compose";
import {
    referencedResourceIds,
    referenceTargets,
    resolveReferences,
} from "../../packages/workflows/src/references";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

// Create every template through the API, then resolve each resource's Variables the way a deploy
// does: a service `environment` value that comes out empty means the container starts without it.
describe("creating every template (PostgreSQL)", () => {
    const databaseName = `clowder_template_create_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;

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

        // SAFETY: createResource reads only identity and active organization from the session.
        context = {
            db,
            session: { user: { id: "owner" }, session: { activeOrganizationId: organizationId } },
        } as Context;
        await db.insert(clusters).values({
            id: clusterId,
            name: "Main",
            organizationId,
            sidecarUrl: "http://127.0.0.1:9",
            sidecarToken: "t",
        });
        await db.insert(projects).values({ id: projectId, clusterId, name: "Apps" });
    });

    afterAll(async () => {
        await db?.$client.end();
        await dropTestDatabase(admin, databaseName);
        await admin?.$client.end();
    });

    it.each(
        templates.flatMap(({ appId, versions }) =>
            Object.keys(versions).map((version) => ({ appId, version })),
        ),
    )("$appId@$version deploys with every variable set", async ({ appId, version }) => {
        const files = templates.find((template) => template.appId === appId)!.versions[version]!;

        const variables = Object.fromEntries(
            summarizeVersion(files).required.map((key) => [key, "required-value"]),
        );

        const app = await call(
            resourcesRouter.createResource,
            { projectId, name: `${appId} ${version}`, template: { appId, version, variables } },
            { context },
        );

        const [group] = await db
            .select()
            .from(resourceGroups)
            .where(eq(resourceGroups.id, app.groupId!));

        expect(group).toMatchObject({ projectId, name: `${appId} ${version}` });

        const created = await db
            .select()
            .from(resources)
            .where(eq(resources.groupId, app.groupId!));

        expect(created).toHaveLength(1 + Object.keys(files.companions).length);

        const empty = await Promise.all(
            created.map(async (resource) => {
                const env = resourceEnv(resource);
                const targets = await referenceTargets(db, clusterId, referencedResourceIds(env));
                const references = resolveReferences(env, targets, undefined, resource.id);

                const resolved = composeServiceVariables(
                    resource.draftSpec!,
                    env,
                    resourceComposePrefix(resource),
                    undefined,
                    references,
                );

                return Object.entries(resolved).flatMap(([key, value]) =>
                    value.trim() ? [] : [`${resource.name}: ${key}`],
                );
            }),
        );

        expect(empty.flat()).toEqual([]);
    });
});
