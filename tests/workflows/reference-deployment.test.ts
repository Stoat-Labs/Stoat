import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { getDeploymentWithLogs } from "@stoat/db/deployments";
import {
    clusters,
    deployments,
    projects,
    resourceDeploymentInputs,
    resources,
} from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Predicate } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";
import {
    deployResource,
    RESOURCE_FAILURE_MESSAGE,
} from "../../packages/workflows/src/deploy-resource";
import { dropTestDatabase } from "../database";

// The worker resolves `{{ <resourceId>.KEY }}` against a fake sidecar that records what it receives.
describe("deploying resources that reference other resources (PostgreSQL)", () => {
    const databaseName = `stoat_references_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const otherClusterId = randomUUID();
    const projectId = randomUUID();
    const siblingProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const internalProjectId = randomUUID();
    const apiId = randomUUID();
    const postgresId = randomUUID();
    const workerId = randomUUID();
    const elsewhereId = randomUUID();
    const internalId = randomUUID();
    const bucketId = randomUUID();
    const domain = "apps.example.test";

    const apiSpec =
        "services:\n  api:\n    image: app\n    environment:\n      DATABASE_URL: ${DATABASE_URL}\n      PASSWORD: ${PASSWORD}\n";

    const postgresSpec = "services:\n  db:\n    image: postgres\n";

    const postgresEnv = [
        "POSTGRES_USER=shop",
        "POSTGRES_PASSWORD='s3cr$$t'",
        "DATABASE_URL=postgres://${POSTGRES_USER}@${DB_INTERNAL_HOST}:5432/shop",
        "PUBLIC_URL=https://shop.${STOAT_DOMAIN}",
    ].join("\n");

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;
    const composes: string[] = [];
    let domainRequests = 0;

    const sidecar = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(Buffer.from(chunk));

        if (request.url?.startsWith("/api/v1/cluster/domain")) {
            domainRequests++;
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ domain, reserved: true }));

            return;
        }

        const body = JSON.parse(Buffer.concat(chunks).toString());
        composes.push(Buffer.from(body.compose, "base64").toString());
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: {"type":"complete","status":"done"}\n\n`);
    });

    const ref = (id: string, key: string) => `{{ ${id}.${key} }}`;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO "user" (id, name, email) VALUES ('referrer', 'Referrer', 'referrer@example.test')`,
        );

        const { rows } = await db.$client.query<{ organization_id: string }>(
            `SELECT organization_id FROM member WHERE user_id = 'referrer'`,
        );

        const organizationId = rows[0]!.organization_id;
        sidecar.listen(0, "127.0.0.1");
        await once(sidecar, "listening");
        const address = sidecar.address();

        if (!address || Predicate.isString(address)) throw new Error("No test sidecar address");
        const sidecarUrl = `http://127.0.0.1:${address.port}`;
        await db.insert(clusters).values([
            { id: clusterId, name: "Main", organizationId, sidecarUrl, sidecarToken: "t" },
            { id: otherClusterId, name: "Other", organizationId, sidecarUrl, sidecarToken: "t" },
        ]);
        await db.insert(projects).values([
            { id: projectId, clusterId, name: "Shop" },
            { id: siblingProjectId, clusterId, name: "Jobs" },
            { id: otherProjectId, clusterId: otherClusterId, name: "Elsewhere" },
            { id: internalProjectId, clusterId, name: "Internal", isInternal: true },
        ]);
        await db.insert(resources).values([
            { id: apiId, projectId, name: "api", draftSpec: apiSpec },
            {
                id: postgresId,
                projectId,
                name: "postgres",
                draftSpec: postgresSpec,
                settings: { env: postgresEnv },
            },
            {
                id: workerId,
                projectId: siblingProjectId,
                name: "worker",
                draftSpec: "services:\n  jobs:\n    image: worker\n",
                settings: { env: "QUEUE=jobs\n" },
            },
            {
                id: elsewhereId,
                projectId: otherProjectId,
                name: "elsewhere",
                draftSpec: postgresSpec,
                settings: { env: "SECRET=elsewhere\n" },
            },
            {
                id: internalId,
                projectId: internalProjectId,
                name: "monitoring",
                draftSpec: postgresSpec,
                settings: { env: "SECRET=internal\n" },
            },
            { id: bucketId, projectId, name: "assets", type: "bucket", settings: { env: "A=1\n" } },
        ]);
    }, 30_000);

    beforeEach(async () => {
        composes.length = 0;
        domainRequests = 0;
        await db
            .update(resources)
            .set({ spec: null, draftSpec: postgresSpec, settings: { env: postgresEnv } })
            .where(eq(resources.id, postgresId));
    });

    afterAll(async () => {
        sidecar.closeAllConnections();
        await new Promise<void>((done) => sidecar.close(() => done()));
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    async function deploy(env: string, spec = apiSpec) {
        const id = randomUUID();
        composes.length = 0;
        await db.transaction(async (tx) => {
            await tx.insert(deployments).values({
                id,
                jobId: id,
                clusterId,
                resourceId: apiId,
                name: "DeployResource",
                spec,
            });
            await tx
                .insert(resourceDeploymentInputs)
                .values({ deploymentId: id, prefix: "p", env });
        });

        let failure: unknown;

        try {
            await deployResource(db, id, new AbortController().signal);
        } catch (error) {
            failure = error;
        }

        const saved = await getDeploymentWithLogs(db, id);

        return { failure, saved, compose: composes.length > 0 ? parse(composes[0]!) : undefined };
    }

    async function rejected(env: string, message: string, spec = apiSpec) {
        const { failure, saved, compose } = await deploy(env, spec);

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain(RESOURCE_FAILURE_MESSAGE);
        expect(saved?.error).toContain(message);
        expect(saved?.logs).toContainEqual(
            expect.objectContaining({
                text: expect.stringContaining(message),
                metadata: { level: "error", event: "attempt-failed" },
            }),
        );
        // Nothing reaches the cluster when references are broken.
        expect(compose).toBeUndefined();
    }

    it("deploys values resolved in the referenced resource's own context", async () => {
        const { failure, saved, compose } = await deploy(
            `DATABASE_URL=${ref(postgresId, "DATABASE_URL")}\nPASSWORD=${ref(postgresId, "POSTGRES_PASSWORD")}\n`,
        );

        expect(failure).toBeUndefined();
        expect(saved?.error).toBeNull();
        expect(compose.services["p-api"].environment).toEqual({
            DATABASE_URL: `postgres://shop@${projectId.slice(0, 8)}-${postgresId.slice(0, 8)}-db.internal:5432/shop`,
            // `$$` keeps the literal `$` away from Uncloud's own interpolation.
            PASSWORD: "s3cr$$t",
        });
    });

    it("resolves references to other projects on the same cluster", async () => {
        const { compose } = await deploy(
            `DATABASE_URL=${ref(workerId, "QUEUE")}\nPASSWORD=${ref(workerId, "JOBS_INTERNAL_HOST")}\n`,
        );

        expect(compose.services["p-api"].environment).toEqual({
            DATABASE_URL: "jobs",
            PASSWORD: `${siblingProjectId.slice(0, 8)}-${workerId.slice(0, 8)}-jobs.internal`,
        });
    });

    it("skips the cluster domain when no resource involved uses it", async () => {
        await db
            .update(resources)
            .set({ settings: { env: "POSTGRES_USER=shop\n" } })
            .where(eq(resources.id, postgresId));
        await deploy(`DATABASE_URL=${ref(postgresId, "POSTGRES_USER")}\n`);

        expect(domainRequests).toBe(0);
    });

    it("fetches the cluster domain when only the referenced resource uses it", async () => {
        const { compose } = await deploy(`DATABASE_URL=${ref(postgresId, "PUBLIC_URL")}\n`);

        expect(domainRequests).toBe(1);
        expect(compose.services["p-api"].environment.DATABASE_URL).toBe(`https://shop.${domain}`);
    });

    it("uses the referenced resource's deployed spec for built-in hosts", async () => {
        await db
            .update(resources)
            .set({ spec: postgresSpec, draftSpec: "services:\n  database:\n    image: postgres\n" })
            .where(eq(resources.id, postgresId));

        const { compose } = await deploy(`DATABASE_URL=${ref(postgresId, "DB_INTERNAL_HOST")}\n`);

        expect(compose.services["p-api"].environment.DATABASE_URL).toMatch(/-db\.internal$/u);
        await rejected(
            `DATABASE_URL=${ref(postgresId, "DATABASE_INTERNAL_HOST")}\n`,
            'Resource "postgres" has no variable DATABASE_INTERNAL_HOST.',
        );
    });

    it("picks up the referenced resource's current values at deploy time", async () => {
        await db
            .update(resources)
            .set({ settings: { env: "POSTGRES_USER=changed\n" } })
            .where(eq(resources.id, postgresId));

        const { compose } = await deploy(`DATABASE_URL=${ref(postgresId, "POSTGRES_USER")}\n`);

        expect(compose.services["p-api"].environment.DATABASE_URL).toBe("changed");
    });

    it("fails when the referenced resource was deleted after the deploy was queued", async () => {
        const goneId = randomUUID();

        await rejected(
            `DATABASE_URL=${ref(goneId, "KEY")}\n`,
            "points to a resource that does not exist on this cluster",
        );
    });

    it.each([
        ["another cluster", () => elsewhereId],
        ["an internal project", () => internalId],
        ["a bucket resource", () => bucketId],
    ])("never resolves resources on %s", async (_, id) => {
        await rejected(
            `DATABASE_URL=${ref(id(), "SECRET")}\n`,
            "points to a resource that does not exist on this cluster",
        );
    });

    it.each([
        ["{{ postgres.POSTGRES_USER }}", "Invalid variable reference {{ postgres.POSTGRES_USER }}"],
        [`{{ ${randomUUID()}.KEY }}`, "does not exist on this cluster"],
        ["MISSING", 'Resource "postgres" has no variable MISSING.'],
    ])("fails with a clear message for %s", async (value, message) => {
        const reference = value === "MISSING" ? ref(postgresId, "MISSING") : value;

        await rejected(`DATABASE_URL=${reference}\n`, message);
    });

    it("rejects a resource referencing itself", async () => {
        await rejected(
            `DATABASE_URL=${ref(apiId, "PASSWORD")}\nPASSWORD=x\n`,
            "points at this resource itself",
        );
    });

    it("rejects references written in Compose instead of Variables", async () => {
        await rejected(
            "",
            "Variable references only work in the resource's Variables, not in Compose",
            `services:\n  api:\n    image: app\n    environment:\n      - URL=${ref(postgresId, "DATABASE_URL")}\n`,
        );
    });

    it("rejects chained references", async () => {
        await db
            .update(resources)
            .set({ settings: { env: `CHAINED=${ref(workerId, "QUEUE")}\n` } })
            .where(eq(resources.id, postgresId));

        await rejected(`DATABASE_URL=${ref(postgresId, "CHAINED")}\n`, "is itself a reference");
    });

    it("names the referenced resource when its own variables are broken", async () => {
        await db
            .update(resources)
            .set({ settings: { env: "BROKEN=${MISSING:?needs a value}\n" } })
            .where(eq(resources.id, postgresId));

        await rejected(
            `DATABASE_URL=${ref(postgresId, "BROKEN")}\n`,
            'Unable to read variables from "postgres"',
        );
    });
});
