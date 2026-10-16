import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { call, createRouterClient } from "@orpc/server";
import { createDb } from "@stoat/db";
import { resourceEnv } from "@stoat/workflows/compose";
import { checkVariableReferences, referenceTargets } from "@stoat/workflows/references";
import { encryptMonitoringPassword } from "@stoat/workflows/secrets";
import {
    clusterMonitoring,
    clusters,
    deployments,
    gitConnections,
    projects,
    resources,
    resourceDeploymentInputs,
} from "@stoat/db/schema/index";
import { asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vite-plus/test";
import type { Context } from "../../packages/api/src/context";
import { projectsRouter } from "../../packages/api/src/routers/projects";
import { resourcesRouter } from "../../packages/api/src/routers/resources";
import { insertUserWithOrganization } from "../users";

describe("core project and resource isolation (PostgreSQL)", () => {
    const databaseName = `stoat_core_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const otherClusterId = randomUUID();
    const foreignClusterId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const foreignProjectId = randomUUID();
    const internalProjectId = randomUUID();
    const legacyProjectId = randomUUID();
    const resourceId = randomUUID();
    const foreignResourceId = randomUUID();
    const internalResourceId = randomUUID();
    const gitConnectionId = randomUUID();
    const spec = "services:\n  web:\n    image: nginx:alpine\n";
    const draftSpec = "services:\n  draft:\n    image: busybox\n";
    const settings = { env: "ORIGINAL=1\n", prefixNames: true, custom: { keep: [1, 2] } };

    const gitSource = {
        repositoryUrl: "https://git.example.test/team/app.git",
        branch: "main",
        path: "compose.yaml",
        revision: "a".repeat(40),
        message: "Initial commit",
        blob: "b".repeat(40),
        tree: "c".repeat(40),
        autoDeploy: false,
        watchPath: ".",
    };

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    let context: Context;
    const client = createRouterClient(resourcesRouter, { context: () => context });
    // The sidecar client calls fetch with a single Request.
    const fetch = vi.fn<(request: Request) => Promise<Response>>();

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });

        const organizationId = await insertUserWithOrganization(
            db,
            "core-member",
            "Core Member",
            "core@example.test",
        );

        const foreignOrganizationId = await insertUserWithOrganization(
            db,
            "foreign-owner",
            "Foreign Owner",
            "foreign@example.test",
        );

        await db.$client.query(`UPDATE member SET role = 'member' WHERE user_id = 'core-member'`);
        // SAFETY: these procedures read only identity and active organization from the session.
        context = {
            db,
            session: {
                user: { id: "core-member" },
                session: { activeOrganizationId: organizationId },
            },
        } as Context;
        await db.insert(clusters).values([
            {
                id: clusterId,
                name: "Owned",
                organizationId,
                sidecarUrl: "http://owned.test",
                sidecarToken: "owned-token",
            },
            {
                id: otherClusterId,
                name: "Other",
                organizationId,
                sidecarUrl: "http://other.test",
                sidecarToken: "other-token",
            },
            {
                id: foreignClusterId,
                name: "Foreign",
                organizationId: foreignOrganizationId,
                sidecarUrl: "http://foreign.test",
                sidecarToken: "foreign-token",
            },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Owned", createdAt: new Date("2020-01-01") },
            {
                id: otherProjectId,
                clusterId: otherClusterId,
                name: "Other",
                createdAt: new Date("2020-01-02"),
            },
            {
                id: legacyProjectId,
                clusterId,
                name: "Legacy",
                isInternal: null,
                createdAt: new Date("2020-01-03"),
            },
            { id: foreignProjectId, clusterId: foreignClusterId, name: "Foreign" },
            { id: internalProjectId, clusterId, name: "Internal", isInternal: true },
        ]);
        await db.insert(gitConnections).values({
            id: gitConnectionId,
            name: "Source",
            organizationId,
            provider: "generic",
            serverUrl: "https://git.example.test",
        });
        await db.insert(resources).values([
            { id: resourceId, projectId, name: "Owned", spec, settings },
            { id: foreignResourceId, projectId: foreignProjectId, name: "Foreign", spec, settings },
            {
                id: internalResourceId,
                projectId: internalProjectId,
                name: "Internal",
                spec,
                settings,
            },
        ]);
    }, 30_000);

    beforeEach(() => {
        fetch.mockReset().mockRejectedValue(new Error("Unexpected external HTTP request"));
        vi.stubGlobal("fetch", fetch);
    });

    afterEach(() => vi.unstubAllGlobals());

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    async function resource(overrides: Partial<typeof resources.$inferInsert> = {}) {
        const [row] = await db
            .insert(resources)
            .values({
                id: randomUUID(),
                projectId,
                name: "Original",
                description: "Original description",
                icon: "original-icon",
                spec,
                draftSpec,
                settings,
                gitConnectionId,
                gitSource,
                createdAt: new Date("2021-01-01"),
                updatedAt: new Date("2021-01-01"),
                ...overrides,
            })
            .returning();

        return row!;
    }

    async function storedResource(id: string) {
        const [row] = await db.select().from(resources).where(eq(resources.id, id));

        return row!;
    }

    it("offers and resolves variable references only within the resource cluster", async () => {
        const sibling = await resource({
            name: "Sibling",
            settings: { env: "SECRET=leak-canary-7f3\n" },
        });

        const otherCluster = await resource({ projectId: otherProjectId, name: "Elsewhere" });

        try {
            await expectReferenceScope(sibling.id, otherCluster.id);
        } finally {
            await db.delete(resources).where(inArray(resources.id, [sibling.id, otherCluster.id]));
        }
    });

    async function expectReferenceScope(siblingId: string, elsewhereId: string) {
        const listed = await call(
            resourcesRouter.listVariableReferences,
            { projectId, resourceId },
            { context },
        );

        const ids = listed.map((target) => target.id);
        expect(ids).toContain(siblingId);
        expect(ids).not.toContain(resourceId);
        expect(ids).not.toContain(foreignResourceId);
        expect(ids).not.toContain(internalResourceId);
        expect(ids).not.toContain(elsewhereId);
        expect(listed.find((target) => target.id === siblingId)).toEqual(
            expect.objectContaining({ keys: expect.arrayContaining(["SECRET"]) }),
        );
        expect(JSON.stringify(listed)).not.toContain("leak-canary-7f3");

        const targets = await referenceTargets(db, clusterId, [
            foreignResourceId,
            internalResourceId,
            elsewhereId,
        ]);

        expect(targets).toEqual([]);
    }

    it("lists only public projects in the active organization, including legacy null flags and zero counts", async () => {
        const listed = await call(projectsRouter.listProjects, undefined, { context });
        expect(listed.map((row) => row.id)).toEqual([projectId, otherProjectId, legacyProjectId]);
        expect(listed.map((row) => row.resourceCount)).toEqual([1, 0, 0]);
        expect(listed.map((row) => row.clusterId)).toEqual([clusterId, otherClusterId, clusterId]);

        for (const row of listed) {
            expect(row).not.toHaveProperty("sidecarToken");
            expect(row).not.toHaveProperty("isInternal");
        }
    });

    it.each([
        {
            name: "  New project  ",
            description: "  Description  ",
            expectedName: "New project",
            expectedDescription: "Description",
        },
        {
            name: "x".repeat(100),
            description: " ",
            expectedName: "x".repeat(100),
            expectedDescription: null,
        },
        {
            name: "No description",
            description: undefined,
            expectedName: "No description",
            expectedDescription: null,
        },
    ])(
        "creates and persists a member's project: $expectedName",
        async ({ name, description, expectedName, expectedDescription }) => {
            const created = await call(
                projectsRouter.createProject,
                { clusterId, name, description },
                { context },
            );

            expect(created).toMatchObject({
                name: expectedName,
                description: expectedDescription,
                clusterId,
                resourceCount: 0,
            });
            expect(created.id).toEqual(expect.any(String));

            const [persisted] = await db
                .select()
                .from(projects)
                .where(eq(projects.id, created.id!));

            expect(persisted).toMatchObject({
                id: created.id,
                name: expectedName,
                description: expectedDescription,
                clusterId,
                isInternal: false,
            });
            const listed = await call(projectsRouter.listProjects, undefined, { context });
            expect(listed.find((row) => row.id === created.id)).toEqual(created);
        },
    );

    it.each(["", " \t\n ", "x".repeat(101)])(
        "rejects invalid project name %j without inserting",
        async (name) => {
            const before = await db.select().from(projects).orderBy(asc(projects.id));
            await expect(
                call(projectsRouter.createProject, { clusterId, name }, { context }),
            ).rejects.toMatchObject({ code: "BAD_REQUEST" });
            expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
        },
    );

    it("rejects an oversized project description without inserting", async () => {
        const before = await db.select().from(projects).orderBy(asc(projects.id));
        await expect(
            call(
                projectsRouter.createProject,
                { clusterId, name: "Valid", description: "x".repeat(501) },
                { context },
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
    });

    it.each([
        ["foreign", foreignClusterId],
        ["missing", randomUUID()],
    ])("cannot create a project in a %s cluster", async (_label, deniedClusterId) => {
        const before = await db.select().from(projects).orderBy(asc(projects.id));
        await expect(
            call(
                projectsRouter.createProject,
                { clusterId: deniedClusterId, name: "Injected" },
                { context },
            ),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await db.select().from(projects).orderBy(asc(projects.id))).toEqual(before);
    });

    it("reads full owned resources but lists only summaries for the requested project in creation order", async () => {
        const first = await resource({
            projectId: otherProjectId,
            createdAt: new Date("2020-01-01"),
        });

        const second = await resource({
            projectId: otherProjectId,
            createdAt: new Date("2020-01-02"),
        });

        expect(
            await client.getResource({ projectId: otherProjectId, resourceId: first.id }),
        ).toEqual(first);
        const listed = await client.listResources({ projectId: otherProjectId });
        expect(listed).toEqual(
            [first, second].map(
                ({
                    id,
                    name,
                    description,
                    icon,
                    type,
                    projectId,
                    gitSource,
                    createdAt,
                    updatedAt,
                }) => ({
                    id,
                    name,
                    description,
                    icon,
                    type,
                    engine: null,
                    projectId,
                    gitBranch: gitSource?.branch ?? null,
                    createdAt,
                    updatedAt,
                    deploymentId: null,
                    deploymentStatus: null,
                    deploymentProgress: null,
                    deploymentCreatedAt: null,
                    deploymentFinishedAt: null,
                    deploymentSource: null,
                    bucketStatus: null,
                }),
            ),
        );

        const project = (await call(projectsRouter.listProjects, undefined, { context })).find(
            (row) => row.id === otherProjectId,
        );

        expect(project?.resourceCount).toBe(2);
        expect(await client.listResources({ projectId: legacyProjectId })).toEqual([]);

        const olderId = randomUUID();
        const latestId = randomUUID();
        await db.insert(deployments).values([
            {
                id: olderId,
                jobId: olderId,
                clusterId,
                resourceId: first.id,
                name: "DeployResource",
                status: "failed",
                createdAt: new Date("2021-01-01"),
            },
            {
                id: latestId,
                jobId: latestId,
                clusterId,
                resourceId: first.id,
                name: "DeployResource",
                status: "running",
                createdAt: new Date("2021-01-02"),
            },
        ]);
        const withStatus = await client.listResources({ projectId: otherProjectId });
        expect(withStatus.map((row) => [row.deploymentId, row.deploymentStatus])).toEqual([
            [latestId, "running"],
            [null, null],
        ]);
    });

    it("allows resource access in a legacy project with a null internal flag", async () => {
        const row = await resource({ projectId: legacyProjectId });
        expect(
            await client.getResource({ projectId: legacyProjectId, resourceId: row.id }),
        ).toEqual(row);
        expect(await client.listResources({ projectId: legacyProjectId })).toMatchObject([
            { id: row.id },
        ]);
    });

    it("creates a resource with trimmed details and no external IO", async () => {
        const created = await client.createResource({
            projectId,
            name: "  Compose  ",
            description: "  Description  ",
        });

        expect(created).toMatchObject({
            projectId,
            name: "Compose",
            description: "Description",
            type: "compose",
            spec: null,
            draftSpec: null,
            settings: null,
        });
        expect(await storedResource(created!.id)).toEqual(created);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("starts a resource from a Compose draft without deploying it", async () => {
        const compose = "services:\n  whoami:\n    image: traefik/whoami\n";

        const created = await client.createResource({ projectId, name: "whoami", compose });

        expect(created).toMatchObject({ draftSpec: compose, spec: null });
        expect(fetch).not.toHaveBeenCalled();
    });

    describe("splitting and regrouping services", () => {
        const stack = `services:
  web:
    image: nginx
    depends_on: [cache]
    environment:
      REDIS_HOST: cache
      CACHE_URL: \${CACHE_URL}
  cache:
    image: redis
`;

        const env = "CACHE_URL=redis://cache:6379\n";

        async function asAdmin<T>(run: () => Promise<T>) {
            await db.$client.query(
                `UPDATE member SET role = 'admin' WHERE user_id = 'core-member'`,
            );

            try {
                return await run();
            } finally {
                await db.$client.query(
                    `UPDATE member SET role = 'member' WHERE user_id = 'core-member'`,
                );
            }
        }

        it("links what stays behind to the split-out service, and undoes it on regroup", async () => {
            const source = await resource({
                spec: null,
                draftSpec: stack,
                settings: { ...settings, env },
            });

            // Another project on the cluster reads the cache's host from the stack.
            const reader = await resource({
                projectId: legacyProjectId,
                spec: null,
                settings: { env: `HOST={{ ${source.id}.CACHE_INTERNAL_HOST }}\n` },
            });

            const ids = [source.id, reader.id];

            try {
                const split = await client.moveService({
                    projectId,
                    fromResourceId: source.id,
                    service: "cache",
                });

                ids.push(split.resourceId);

                const left = await storedResource(source.id);
                const created = await storedResource(split.resourceId);
                const link = `{{ ${split.resourceId}.CACHE_SERVICE_NAME }}`;

                expect(left.draftSpec).toContain("REDIS_HOST: ${CACHE_SERVICE_NAME}");
                expect(left.draftSpec).not.toContain("depends_on");
                // Variables are saved beside the other settings, never over them.
                expect(left.settings).toEqual({
                    ...settings,
                    env: `CACHE_URL=redis://${link}:6379\nCACHE_SERVICE_NAME=${link}\n`,
                });
                expect(created).toMatchObject({
                    name: "cache",
                    draftSpec: "services:\n  cache:\n    image: redis\n",
                    settings: { env: "" },
                });
                expect((await storedResource(reader.id)).settings).toEqual({
                    env: `HOST={{ ${split.resourceId}.CACHE_INTERNAL_HOST }}\n`,
                });

                const graph = await client.getProjectGraph({ projectId });

                expect(graph.resources.find((entry) => entry.id === source.id)?.references).toEqual(
                    [split.resourceId],
                );

                const merged = await asAdmin(() =>
                    client.moveService({
                        projectId,
                        fromResourceId: split.resourceId,
                        toResourceId: source.id,
                        service: "cache",
                        removeEmptySource: true,
                    }),
                );

                expect(merged.removedResourceId).toBe(split.resourceId);

                const regrouped = await storedResource(source.id);

                expect(regrouped.draftSpec).toContain("REDIS_HOST: cache");
                expect(regrouped.settings).toEqual({ ...settings, env });
                expect((await storedResource(reader.id)).settings).toEqual({
                    env: `HOST={{ ${source.id}.CACHE_INTERNAL_HOST }}\n`,
                });
                expect(
                    await db.select().from(resources).where(eq(resources.id, split.resourceId)),
                ).toEqual([]);
            } finally {
                await db.delete(resources).where(inArray(resources.id, ids));
            }
        });

        it("lets the stack deploy before a running target has deployed the service it gained", async () => {
            const running = "services:\n  web:\n    image: nginx\n";
            const source = await resource({ spec: null, draftSpec: stack, settings: { env } });

            const target = await resource({
                spec: running,
                draftSpec: running,
                settings: { env: "" },
            });

            try {
                await client.moveService({
                    projectId,
                    fromResourceId: source.id,
                    toResourceId: target.id,
                    service: "cache",
                });

                const left = await storedResource(source.id);

                expect(resourceEnv(left)).toContain(`{{ ${target.id}.CACHE_SERVICE_NAME }}`);
                await expect(
                    checkVariableReferences(
                        db,
                        clusterId,
                        source.id,
                        left.draftSpec!,
                        resourceEnv(left),
                    ),
                ).resolves.toBeUndefined();
            } finally {
                await db.delete(resources).where(inArray(resources.id, [source.id, target.id]));
            }
        });

        it("keeps an unprefixed stack's split-out services unprefixed", async () => {
            const source = await resource({
                spec: null,
                draftSpec: stack,
                settings: { env, prefixNames: false },
            });

            const ids = [source.id];

            try {
                const split = await client.moveService({
                    projectId,
                    fromResourceId: source.id,
                    service: "cache",
                });

                ids.push(split.resourceId);

                expect((await storedResource(split.resourceId)).settings).toEqual({
                    env: "",
                    prefixNames: false,
                });
            } finally {
                await db.delete(resources).where(inArray(resources.id, ids));
            }
        });

        it("leaves resources on other clusters alone", async () => {
            const source = await resource({ spec: null, draftSpec: stack, settings: { env } });

            const foreign = await resource({
                projectId: otherProjectId,
                spec: null,
                settings: { env: `HOST={{ ${source.id}.CACHE_INTERNAL_HOST }}\n` },
            });

            const ids = [source.id, foreign.id];

            try {
                const split = await client.moveService({
                    projectId,
                    fromResourceId: source.id,
                    service: "cache",
                });

                ids.push(split.resourceId);

                expect((await storedResource(foreign.id)).settings).toEqual({
                    env: `HOST={{ ${source.id}.CACHE_INTERNAL_HOST }}\n`,
                });
            } finally {
                await db.delete(resources).where(inArray(resources.id, ids));
            }
        });
    });

    describe("moving and copying resources between projects", () => {
        it("moves drafts and deployed resources within the cluster, keeping their names", async () => {
            const draft = await resource({ spec: null });
            const live = await resource();
            const deploymentId = randomUUID();

            // Named after its slug rather than its project, so it keeps running as it is.
            await db.insert(deployments).values({
                id: deploymentId,
                jobId: deploymentId,
                clusterId,
                resourceId: live.id,
                name: "DeployResource",
                status: "ready",
            });
            await db
                .insert(resourceDeploymentInputs)
                .values({ deploymentId, prefix: live.slug });

            try {
                for (const movable of [draft, live])
                    expect(
                        await client.moveResource({
                            projectId,
                            resourceId: movable.id,
                            toProjectId: legacyProjectId,
                        }),
                    ).toMatchObject({
                        id: movable.id,
                        projectId: legacyProjectId,
                        slug: movable.slug,
                    });
            } finally {
                await db.delete(deployments).where(eq(deployments.id, deploymentId));
                await db.delete(resources).where(inArray(resources.id, [draft.id, live.id]));
            }
        });

        it("refuses to move a deployed resource to another cluster", async () => {
            const live = await resource();
            const deploymentId = randomUUID();

            // Unprefixed, so only the cluster change would orphan its services.
            await db.insert(deployments).values({
                id: deploymentId,
                jobId: deploymentId,
                clusterId,
                resourceId: live.id,
                name: "DeployResource",
                status: "ready",
            });

            try {
                await expect(
                    client.moveResource({
                        projectId,
                        resourceId: live.id,
                        toProjectId: otherProjectId,
                    }),
                ).rejects.toMatchObject({ code: "CONFLICT" });
                expect((await storedResource(live.id)).projectId).toBe(projectId);
            } finally {
                await db.delete(deployments).where(eq(deployments.id, deploymentId));
                await db.delete(resources).where(eq(resources.id, live.id));
            }
        });

        it("refuses to move a draft to another cluster while it is referenced", async () => {
            const draft = await resource({ spec: null });

            const reader = await resource({
                name: "Reader",
                settings: { env: `URL={{ ${draft.id}.URL }}\n` },
            });

            try {
                await expect(
                    client.moveResource({
                        projectId,
                        resourceId: draft.id,
                        toProjectId: otherProjectId,
                    }),
                ).rejects.toMatchObject({ code: "CONFLICT" });
                expect((await storedResource(draft.id)).projectId).toBe(projectId);
            } finally {
                await db.delete(resources).where(inArray(resources.id, [draft.id, reader.id]));
            }
        });

        it("copies the configuration as a new draft, never the deployment", async () => {
            const original = await resource();

            try {
                const copy = await client.copyResource({
                    projectId,
                    resourceId: original.id,
                    toProjectId: otherProjectId,
                    name: "  Copy  ",
                });

                expect(copy).toMatchObject({
                    projectId: otherProjectId,
                    name: "Copy",
                    icon: original.icon,
                    spec: null,
                    draftSpec,
                    settings,
                    gitConnectionId,
                    gitSource,
                });
                expect(copy?.id).not.toBe(original.id);
                await db.delete(resources).where(eq(resources.id, copy!.id));
            } finally {
                await db.delete(resources).where(eq(resources.id, original.id));
            }
        });

        it("keeps resources out of foreign and internal projects", async () => {
            const draft = await resource({ spec: null });

            try {
                for (const toProjectId of [foreignProjectId, internalProjectId]) {
                    await expect(
                        client.moveResource({ projectId, resourceId: draft.id, toProjectId }),
                    ).rejects.toMatchObject({ code: "NOT_FOUND" });
                    await expect(
                        client.copyResource({
                            projectId,
                            resourceId: draft.id,
                            toProjectId,
                            name: "Leak",
                        }),
                    ).rejects.toMatchObject({ code: "NOT_FOUND" });
                }

                expect((await storedResource(draft.id)).projectId).toBe(projectId);
            } finally {
                await db.delete(resources).where(eq(resources.id, draft.id));
            }
        });
    });

    it("discards staged changes back to the last deploy, removing never-deployed drafts", async () => {
        const live = await resource({
            settings: { env: "STAGED=1\n", prefixNames: true, custom: "kept" },
        });

        const draft = await resource({ spec: null });
        const deploymentId = randomUUID();

        await db.insert(deployments).values({
            id: deploymentId,
            jobId: deploymentId,
            clusterId,
            resourceId: live.id,
            name: "DeployResource",
            status: "ready",
            finishedAt: new Date("2021-02-01"),
        });
        await db
            .insert(resourceDeploymentInputs)
            .values({ deploymentId, prefix: "", env: "LIVE=1\n" });

        const input = { projectId, resourceIds: [live.id, draft.id] };

        try {
            // Discarding throws away work, so it is for admins, like deploying.
            await expect(client.discardChanges(input)).rejects.toMatchObject({
                code: "FORBIDDEN",
            });
            await db.$client.query(
                `UPDATE member SET role = 'admin' WHERE user_id = 'core-member'`,
            );

            expect(await client.discardChanges(input)).toEqual({ restored: 1, removed: 1 });
            expect(await storedResource(live.id)).toMatchObject({
                draftSpec: spec,
                settings: { env: "LIVE=1\n", prefixNames: false, custom: "kept" },
            });
            expect(await db.select().from(resources).where(eq(resources.id, draft.id))).toEqual([]);
        } finally {
            await db.$client.query(
                `UPDATE member SET role = 'member' WHERE user_id = 'core-member'`,
            );
            await db.delete(deployments).where(eq(deployments.id, deploymentId));
            await db.delete(resources).where(inArray(resources.id, [live.id, draft.id]));
        }
    });

    it("compares what a resource runs with what its next deploy ships", async () => {
        const staged = await resource({ settings: { env: "NEXT=1\n", prefixNames: true } });

        try {
            const changes = await client.getPendingChanges({ projectId, resourceId: staged.id });

            expect(changes).toEqual({
                firstDeploy: false,
                compose: { live: spec, next: draftSpec },
                // Never deployed through a recorded deploy, so nothing is live to compare with.
                env: { live: "", next: "NEXT=1\n" },
                prefix: { live: null, next: expect.any(String) },
            });
            await expect(
                client.getPendingChanges({
                    projectId: foreignProjectId,
                    resourceId: foreignResourceId,
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
        } finally {
            await db.delete(resources).where(eq(resources.id, staged.id));
        }
    });

    it("stars projects per user and shows each resource's tile in the overview", async () => {
        const overview = async () =>
            (await call(projectsRouter.listProjectOverviews, undefined, { context })).find(
                (row) => row.id === projectId,
            );

        await call(projectsRouter.setFavorite, { projectId, favorite: true }, { context });
        // Starring twice is harmless.
        await call(projectsRouter.setFavorite, { projectId, favorite: true }, { context });

        const starred = await overview();

        expect(starred?.favorite).toBe(true);
        expect(starred?.resources.find((row) => row.id === resourceId)).toMatchObject({
            image: "nginx:alpine",
            icon: null,
        });
        expect(JSON.stringify(starred)).not.toContain("ORIGINAL=1");

        await call(projectsRouter.setFavorite, { projectId, favorite: false }, { context });
        expect((await overview())?.favorite).toBe(false);

        for (const deniedProjectId of [foreignProjectId, internalProjectId])
            await expect(
                call(
                    projectsRouter.setFavorite,
                    { projectId: deniedProjectId, favorite: true },
                    { context },
                ),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects an invalid Compose draft and one combined with a template", async () => {
        const before = await db.select().from(resources).orderBy(asc(resources.id));

        await expect(
            client.createResource({ projectId, name: "broken", compose: "services: [" }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(
            client.createResource({
                projectId,
                name: "both",
                compose: "services:\n  web:\n    image: nginx\n",
                template: { appId: "postgresql", version: "18" },
            }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(before);
    });

    describe.each([
        {
            label: "foreign organization",
            projectId: foreignProjectId,
            resourceId: foreignResourceId,
        },
        {
            label: "mismatched same-organization project",
            clusterId: otherClusterId,
            projectId: otherProjectId,
            resourceId,
        },
        {
            label: "foreign resource under an owned project",
            projectId,
            resourceId: foreignResourceId,
        },
        { label: "missing project", projectId: randomUUID(), resourceId },
        { label: "missing resource", projectId, resourceId: randomUUID() },
        { label: "internal project", projectId: internalProjectId, resourceId: internalResourceId },
    ])("$label", (input) => {
        it.each([
            "getResource",
            "getFormattedCompose",
            "getContainers",
            "updateSettings",
            "updateVariables",
            "updateDetails",
        ] as const)("denies %s without writes or external IO", async (operation) => {
            const before = await db.select().from(resources).orderBy(asc(resources.id));
            await expect(
                client[operation]({
                    clusterId,
                    ...input,
                    prefixNames: false,
                    env: "INJECTED=1",
                    name: "Injected",
                    description: "Injected",
                    icon: "injected-icon",
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(before);
            expect(fetch).not.toHaveBeenCalled();
        });
    });

    describe.each([
        ["foreign", foreignProjectId],
        ["internal", internalProjectId],
        ["missing", randomUUID()],
    ])("%s project", (_label, deniedProjectId) => {
        it.each(["listResources", "createResource"] as const)(
            "denies %s without writes",
            async (operation) => {
                const before = await db.select().from(resources).orderBy(asc(resources.id));
                await expect(
                    client[operation]({ projectId: deniedProjectId, name: "Injected" }),
                ).rejects.toMatchObject({ code: "NOT_FOUND" });
                expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(
                    before,
                );
                expect(fetch).not.toHaveBeenCalled();
            },
        );
    });

    describe("internal projects for organization admins", () => {
        beforeAll(async () => {
            await db.$client.query(
                `UPDATE member SET role = 'admin' WHERE user_id = 'core-member'`,
            );
        });

        afterAll(async () => {
            await db.$client.query(
                `UPDATE member SET role = 'member' WHERE user_id = 'core-member'`,
            );
        });

        it("reads the internal project under a derived cluster name", async () => {
            expect(
                await call(
                    projectsRouter.getProject,
                    { projectId: internalProjectId },
                    { context },
                ),
            ).toMatchObject({
                id: internalProjectId,
                clusterId,
                name: "Owned-internal",
                isInternal: true,
            });
            expect(await call(projectsRouter.getProject, { projectId }, { context })).toMatchObject(
                { id: projectId, name: "Owned", isInternal: false },
            );
        });

        it("still hides the internal project from ordinary project lists", async () => {
            const listed = await call(projectsRouter.listProjects, undefined, { context });
            expect(listed.map((row) => row.id)).not.toContain(internalProjectId);
        });

        it("reads internal resources", async () => {
            expect(
                await client.getResource({
                    projectId: internalProjectId,
                    resourceId: internalResourceId,
                }),
            ).toMatchObject({ id: internalResourceId, projectId: internalProjectId });
            expect(
                (await client.listResources({ projectId: internalProjectId })).map((row) => row.id),
            ).toEqual([internalResourceId]);
        });

        it("derives monitoring variables without storing them", async () => {
            const secret = "monitoring-env-test-secret-at-least-32-bytes";
            vi.stubEnv("APP_SECRET", secret);
            await db.insert(clusterMonitoring).values({
                clusterId,
                projectId: internalProjectId,
                resourceId: internalResourceId,
                encryptedPassword: encryptMonitoringPassword("s3cret", secret, clusterId),
            });
            // A pre-rename configuration still holds the machine ID.
            await db
                .update(clusters)
                .set({
                    initializationConfiguration: {
                        machine: "machine-id-1",
                        greptimeStorage: { type: "volume", source: "greptime" },
                        alloyStorage: { type: "volume", source: "alloy" },
                        retentionDays: 14,
                    },
                })
                .where(eq(clusters.id, clusterId));
            fetch.mockImplementation(async () =>
                Response.json({ items: [{ id: "machine-id-1", name: "edge-1", state: "Up" }] }),
            );

            try {
                const read = await client.getResource({
                    projectId: internalProjectId,
                    resourceId: internalResourceId,
                });

                expect(read.settings).toMatchObject({
                    machine: "edge-1",
                    env: expect.stringContaining("GREPTIME_PASSWORD=s3cret\n"),
                });
                expect(read.settings).toMatchObject({
                    env: expect.stringContaining("GREPTIME_MACHINE=edge-1\n"),
                });
                expect(read.settings).toMatchObject({
                    env: expect.stringContaining(`CLUSTER_ID=${clusterId}\n`),
                });
                expect((await storedResource(internalResourceId)).settings).toEqual(settings);

                fetch
                    .mockReset()
                    .mockImplementation(async () =>
                        Response.json({ containers: [{ id: "monitoring-container" }] }),
                    );
                expect(
                    await client.getContainers({
                        clusterId,
                        projectId: internalProjectId,
                        resourceId: internalResourceId,
                    }),
                ).toHaveLength(2);
                expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([
                    expect.stringContaining("/api/v1/services/stoat-monitoring-greptimedb"),
                    expect.stringContaining("/api/v1/services/stoat-monitoring-alloy"),
                ]);
            } finally {
                await db
                    .delete(clusterMonitoring)
                    .where(eq(clusterMonitoring.clusterId, clusterId));
                await db
                    .update(clusters)
                    .set({ initializationConfiguration: null })
                    .where(eq(clusters.id, clusterId));
            }
        });

        it.each([
            "updateSettings",
            "updateVariables",
            "updateDetails",
            "updateComposeSpec",
            "createResource",
        ] as const)("denies %s on internal resources without writes", async (operation) => {
            const before = await db.select().from(resources).orderBy(asc(resources.id));
            await expect(
                client[operation]({
                    projectId: internalProjectId,
                    resourceId: internalResourceId,
                    prefixNames: false,
                    env: "INJECTED=1",
                    name: "Injected",
                    spec: "services: {}\n",
                    expectedSpec: null,
                    expectedSource: null,
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await db.select().from(resources).orderBy(asc(resources.id))).toEqual(before);
            expect(fetch).not.toHaveBeenCalled();
        });
    });

    it("hides the internal project from members by id", async () => {
        await expect(
            call(projectsRouter.getProject, { projectId: internalProjectId }, { context }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it.each(["updateSettings", "updateVariables", "updateDetails"] as const)(
        "rejects %s on a non-compose resource without mutation",
        async (operation) => {
            const row = await resource({ type: "other" });
            await expect(
                client[operation]({
                    projectId,
                    resourceId: row.id,
                    prefixNames: false,
                    env: "INJECTED=1",
                    name: "Injected",
                }),
            ).rejects.toMatchObject({ code: "NOT_FOUND" });
            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it.each(["updateSettings", "updateVariables"] as const)(
        "%s preserves unrelated settings, details, Compose, and Git metadata",
        async (operation) => {
            const row = await resource();

            const updated = await client[operation]({
                projectId,
                resourceId: row.id,
                prefixNames: false,
                env: "  RAW='value'\n# keep formatting\n",
            });

            const expectedSettings =
                operation === "updateSettings"
                    ? { ...settings, prefixNames: false }
                    : { ...settings, env: "  RAW='value'\n# keep formatting\n" };

            expect(updated).toEqual({
                ...row,
                settings: expectedSettings,
                updatedAt: expect.any(Date),
            });
            expect(updated.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
            expect(await storedResource(row.id)).toEqual(updated);
        },
    );

    it.each(["updateSettings", "updateVariables"] as const)(
        "%s initializes null settings",
        async (operation) => {
            const row = await resource({ settings: null });

            const updated = await client[operation]({
                projectId,
                resourceId: row.id,
                prefixNames: false,
                env: "",
            });

            expect(updated).toEqual({
                ...row,
                settings: operation === "updateSettings" ? { prefixNames: false } : { env: "" },
                updatedAt: expect.any(Date),
            });
            expect(await storedResource(row.id)).toEqual(updated);
        },
    );

    it("clears variables without discarding other settings", async () => {
        const row = await resource();
        const updated = await client.updateVariables({ projectId, resourceId: row.id, env: "" });
        expect(await storedResource(row.id)).toEqual({
            ...row,
            settings: { ...settings, env: "" },
            updatedAt: updated.updatedAt,
        });
    });

    it.each([null, settings])(
        "preserves both concurrent settings and variables edits starting from %j",
        async (initialSettings) => {
            const row = await resource({ settings: initialSettings });
            const lock = await db.$client.connect();
            await lock.query("BEGIN");
            await lock.query("SELECT id FROM resources WHERE id = $1 FOR UPDATE", [row.id]);

            const edits = Promise.allSettled([
                client.updateSettings({ projectId, resourceId: row.id, prefixNames: false }),
                client.updateVariables({ projectId, resourceId: row.id, env: "CONCURRENT=1\n" }),
            ]);

            try {
                // Hold both writes at the row lock so they really contend, rather than run serially.
                await expect
                    .poll(
                        async () => {
                            const result = await db.$client.query<{ count: number }>(
                                `SELECT count(*)::int AS count FROM pg_stat_activity
                                 WHERE datname = current_database() AND wait_event_type = 'Lock'
                                 AND query LIKE 'update "resources"%'`,
                            );

                            return result.rows[0]!.count;
                        },
                        { timeout: 3000 },
                    )
                    .toBe(2);
            } finally {
                await lock.query("ROLLBACK");
                lock.release();
                await edits;
            }

            expect((await edits).map((result) => result.status)).toEqual([
                "fulfilled",
                "fulfilled",
            ]);
            expect(await storedResource(row.id)).toEqual({
                ...row,
                settings: { ...initialSettings, prefixNames: false, env: "CONCURRENT=1\n" },
                updatedAt: expect.any(Date),
            });
        },
    );

    it("updates trimmed details while preserving settings, Compose, and Git metadata", async () => {
        const row = await resource();

        const updated = await client.updateDetails({
            projectId,
            resourceId: row.id,
            name: "  Renamed  ",
            description: "  New description  ",
            icon: "  new-icon  ",
        });

        expect(updated).toEqual({
            ...row,
            name: "Renamed",
            description: "New description",
            icon: "new-icon",
            updatedAt: expect.any(Date),
        });
        expect(await storedResource(row.id)).toEqual(updated);
    });

    it.each([
        { description: " \t ", icon: " \n " },
        { description: undefined, icon: undefined },
    ])("clears empty or omitted optional details: %j", async (details) => {
        const row = await resource();

        const updated = await client.updateDetails({
            projectId,
            resourceId: row.id,
            name: "Renamed",
            ...details,
        });

        expect(await storedResource(row.id)).toEqual({
            ...row,
            name: "Renamed",
            description: null,
            icon: null,
            updatedAt: updated.updatedAt,
        });
    });

    it.each([
        { name: "" },
        { name: " \t\n " },
        { name: "x".repeat(101) },
        { name: "Valid", description: "x".repeat(501) },
    ])("rejects invalid resource details %j without mutation", async (details) => {
        const row = await resource();
        await expect(
            client.updateDetails({ projectId, resourceId: row.id, ...details }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(await storedResource(row.id)).toEqual(row);
    });

    it("previews the saved draft with editable settings without changing deployed source", async () => {
        const row = await resource({ settings: { prefixNames: false } });
        const preview = await client.getFormattedCompose({ projectId, resourceId: row.id });
        expect(preview).toMatchObject({
            prefix: undefined,
            serviceNames: ["draft"],
            serviceCount: 1,
        });
        expect(preview.yaml).toContain("busybox");
        expect(preview.yaml).not.toContain("nginx");
        expect(await storedResource(row.id)).toEqual(row);
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        { draftSpec: null, code: "NOT_FOUND" },
        { draftSpec: "", code: "NOT_FOUND" },
        { draftSpec: "services: [broken", code: "BAD_REQUEST" },
    ])(
        "does not preview deployed Compose when the draft is unusable: %j",
        async ({ draftSpec, code }) => {
            const row = await resource({ draftSpec });
            await expect(
                client.getFormattedCompose({ projectId, resourceId: row.id }),
            ).rejects.toMatchObject({ code });
            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it.each([true, false])(
        "gets deployed containers with legacy prefixNames=%s when no snapshot exists",
        async (prefixNames) => {
            const row = await resource({
                spec: "services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n",
                settings: { prefixNames },
            });

            const webContainers = [{ id: "web-1" }, { id: "web-2" }];
            const workerContainers = [{ id: "worker-1" }];
            fetch.mockImplementation(async (request) =>
                Response.json({
                    containers:
                        request.url.endsWith("-web") || request.url.endsWith("/web")
                            ? webContainers
                            : workerContainers,
                }),
            );
            expect(
                await client.getContainers({ clusterId, projectId, resourceId: row.id }),
            ).toEqual([...webContainers, ...workerContainers]);
            const prefix = prefixNames ? `${row.slug}-` : "";
            expect(fetch.mock.calls.map(([request]) => request.url).sort()).toEqual([
                `http://owned.test/api/v1/services/${prefix}web`,
                `http://owned.test/api/v1/services/${prefix}worker`,
            ]);

            for (const [request] of fetch.mock.calls) {
                expect(request.headers.get("authorization")).toBe("Bearer owned-token");
                expect(request.method).toBe("GET");
            }

            expect(await storedResource(row.id)).toEqual(row);
        },
    );

    it("gets containers from the saved draft when the resource has never been deployed", async () => {
        const row = await resource({
            spec: null,
            draftSpec: spec,
            settings: { prefixNames: false },
        });

        const containers = [{ id: "draft-web-1" }];
        fetch.mockResolvedValue(Response.json({ containers }));

        await expect(
            client.getContainers({ clusterId, projectId, resourceId: row.id }),
        ).resolves.toEqual(containers);
        expect(fetch.mock.calls[0]?.[0].url).toContain("/api/v1/services/web");
        expect(
            await db
                .select({ id: deployments.id })
                .from(deployments)
                .where(eq(deployments.resourceId, row.id)),
        ).toEqual([]);
    });

    it.each(["captured-prefix", ""])(
        "uses deployed source and latest ready snapshot prefix %j despite draft/settings edits",
        async (prefix) => {
            const row = await resource();
            const other = await resource();

            for (const entry of [
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-04",
                    finished: "2025-01-04",
                    prefix: "older-finish",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-01",
                    finished: "2025-01-05",
                    prefix: "older-created",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-02",
                    finished: "2025-01-05",
                    prefix,
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "failed",
                    created: "2025-01-06",
                    finished: "2025-01-06",
                    prefix: "failed",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "cancelled",
                    created: "2025-01-07",
                    finished: "2025-01-07",
                    prefix: "cancelled",
                },
                {
                    resourceId: row.id,
                    name: "DeployResource",
                    status: "queued",
                    created: "2025-01-08",
                    finished: null,
                    prefix: "queued",
                },
                {
                    resourceId: row.id,
                    name: "InitializeCluster",
                    status: "ready",
                    created: "2025-01-09",
                    finished: "2025-01-09",
                    prefix: "wrong-job",
                },
                {
                    resourceId: other.id,
                    name: "DeployResource",
                    status: "ready",
                    created: "2025-01-10",
                    finished: "2025-01-10",
                    prefix: "other-resource",
                },
            ]) {
                const id = randomUUID();
                await db.insert(deployments).values({
                    id,
                    jobId: id,
                    clusterId,
                    resourceId: entry.resourceId,
                    name: entry.name,
                    spec: entry.status === "ready" ? spec : draftSpec,
                    status: entry.status,
                    createdAt: new Date(entry.created),
                    finishedAt: entry.finished ? new Date(entry.finished) : null,
                });
                await db.insert(resourceDeploymentInputs).values({
                    deploymentId: id,
                    prefix: entry.prefix,
                });
            }

            await client.updateComposeSpec({
                projectId,
                resourceId: row.id,
                spec: "services: [invalid draft",
                expectedSpec: draftSpec,
                expectedSource: { connectionId: gitConnectionId, ...gitSource },
            });
            await client.updateSettings({
                projectId,
                resourceId: row.id,
                prefixNames: prefix === "",
            });
            fetch.mockResolvedValue(Response.json({ containers: [{ id: "deployed-web" }] }));
            expect(
                await client.getContainers({ clusterId, projectId, resourceId: row.id }),
            ).toEqual([{ id: "deployed-web" }]);
            expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([
                `http://owned.test/api/v1/services/${prefix ? `${prefix}-` : ""}web`,
            ]);
            expect(await storedResource(row.id)).toMatchObject({
                spec,
                draftSpec: "services: [invalid draft",
            });
        },
    );

    it("rejects a mismatched same-organization cluster before external IO", async () => {
        fetch.mockResolvedValue(Response.json({ containers: [] }));
        await expect(
            client.getContainers({ clusterId: otherClusterId, projectId, resourceId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ["foreign", foreignClusterId],
        ["missing", randomUUID()],
    ])("rejects a %s cluster before external IO", async (_label, deniedClusterId) => {
        await expect(
            client.getContainers({ clusterId: deniedClusterId, projectId, resourceId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("omits sidecar 404s while retaining containers from other services", async () => {
        const row = await resource({
            spec: "services:\n  web:\n    image: nginx\n  missing:\n    image: busybox\n",
            settings: { prefixNames: false },
        });

        fetch.mockImplementation(async (request) =>
            request.url.endsWith("/missing")
                ? Response.json({ error: "Service not found" }, { status: 404 })
                : Response.json({ containers: [{ id: "web-1" }] }),
        );
        expect(await client.getContainers({ clusterId, projectId, resourceId: row.id })).toEqual([
            { id: "web-1" },
        ]);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("propagates sidecar errors instead of reporting an empty container list", async () => {
        fetch.mockResolvedValue(Response.json({ error: "Sidecar unavailable" }, { status: 503 }));
        await expect(client.getContainers({ clusterId, projectId, resourceId })).rejects.toThrow(
            "Sidecar unavailable",
        );
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        { spec: null, draftSpec: null, code: "NOT_FOUND" },
        { spec: "", draftSpec: "", code: "NOT_FOUND" },
        { spec: "services: [broken", draftSpec: draftSpec, code: "BAD_REQUEST" },
    ])("rejects unusable Compose before external IO: %j", async ({ spec, draftSpec, code }) => {
        const row = await resource({ spec, draftSpec });
        await expect(
            client.getContainers({ clusterId, projectId, resourceId: row.id }),
        ).rejects.toMatchObject({ code });
        expect(fetch).not.toHaveBeenCalled();
    });
});
