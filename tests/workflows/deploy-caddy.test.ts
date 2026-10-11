import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@stoat/db";
import { clusters, deployments } from "@stoat/db/schema/index";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
    CADDY_METRICS_ENV,
    CaddyDeploymentInProgressError,
    createCaddyDeployment,
    caddyComposeSpec,
    parseCaddyComposeSpec,
    withCaddyMetrics,
} from "../../packages/workflows/src/deploy-caddy";

describe("caddy deployment spec", () => {
    it("round-trips the image and a multi-line global Caddyfile", () => {
        const caddyfile = "{\n\temail ops@example.com\n}\n\n(headers) {\n\theader -Server\n}";
        const spec = caddyComposeSpec("ghcr.io/example/caddy:2.10", `\n${caddyfile}\n`);

        expect(spec).toContain("x-caddy: |");
        expect(parseCaddyComposeSpec(spec)).toEqual({
            image: "ghcr.io/example/caddy:2.10",
            caddyfile: `${caddyfile}\n`,
        });
    });

    it("omits x-caddy when the Caddyfile is blank", () => {
        const spec = caddyComposeSpec("caddy:2", "  \n");

        expect(spec).not.toContain("x-caddy");
        expect(parseCaddyComposeSpec(spec)).toEqual({ image: "caddy:2", caddyfile: "" });
    });

    it("rejects a spec without an image", () => {
        expect(() => parseCaddyComposeSpec("services:\n  caddy: {}\n")).toThrow();
    });

    it("round-trips the container environment", () => {
        const spec = caddyComposeSpec("caddy:2", "", CADDY_METRICS_ENV);

        expect(parseCaddyComposeSpec(spec)).toEqual({
            image: "caddy:2",
            caddyfile: "",
            env: CADDY_METRICS_ENV,
        });
    });
});

describe("caddy metrics", () => {
    it("creates the global options block when there is none", () => {
        expect(withCaddyMetrics("")).toBe("{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n}\n");
        expect(withCaddyMetrics("(headers) {\n\theader -Server\n}\n")).toBe(
            "{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n}\n\n(headers) {\n\theader -Server\n}\n",
        );
    });

    it("adds metrics to an existing global options block, after leading comments", () => {
        const caddyfile = "# Global\n{\n\temail ops@example.com\n}\n\nexample.com {\n\tmetrics\n}";

        expect(withCaddyMetrics(caddyfile)).toBe(
            "# Global\n{\n\tmetrics {\n\t\tper_host\n\t\totlp\n\t}\n\temail ops@example.com\n}\n\nexample.com {\n\tmetrics\n}\n",
        );
    });

    it("keeps a metrics option the user configured, and is idempotent", () => {
        const custom = "{\n\tservers {\n\t\ttimeouts {\n\t\t\tidle 1m\n\t\t}\n\t}\n\tmetrics\n}";

        expect(withCaddyMetrics(custom)).toBe(custom);
        expect(withCaddyMetrics(withCaddyMetrics("{\n\temail a@b.c\n}"))).toBe(
            withCaddyMetrics("{\n\temail a@b.c\n}"),
        );
    });
});

describe("caddy deployment rows (PostgreSQL)", () => {
    const databaseName = `stoat_caddy_test_${randomUUID().replaceAll("-", "")}`;
    const organizationId = randomUUID();
    const clusterId = randomUUID();

    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        await db.$client.query(
            `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Caddy', $1, now())`,
            [organizationId],
        );
        await db.insert(clusters).values({
            id: clusterId,
            organizationId,
            name: "Caddy cluster",
            sidecarUrl: "http://sidecar.test",
            sidecarToken: "secret",
        });
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await admin.$client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.$client.end();
        }
    });

    it("queues one rollout at a time, with metrics only when monitoring runs", async () => {
        const id = await createCaddyDeployment(db, clusterId, "caddy:2", "", true);

        await expect(createCaddyDeployment(db, clusterId, "caddy:2", "", false)).rejects.toThrow(
            CaddyDeploymentInProgressError,
        );

        const [row] = await db.select().from(deployments).where(eq(deployments.id, id));
        expect(row).toMatchObject({ name: "DeployCaddy", status: "queued", jobId: id });
        expect(parseCaddyComposeSpec(row!.spec!)).toEqual({
            image: "caddy:2",
            caddyfile: withCaddyMetrics(""),
            env: CADDY_METRICS_ENV,
        });

        await db.update(deployments).set({ status: "ready" }).where(eq(deployments.id, id));
        const plain = await createCaddyDeployment(db, clusterId, "caddy:2", "", false);
        const [next] = await db.select().from(deployments).where(eq(deployments.id, plain));
        expect(parseCaddyComposeSpec(next!.spec!)).toEqual({ image: "caddy:2", caddyfile: "" });
    });
});
