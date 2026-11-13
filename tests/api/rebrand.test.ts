import { createDb } from "@clowder/db";
import { usesLegacyNames } from "@clowder/workflows/deploy-resource";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

const MIGRATION = resolve(
    "packages/db/src/migrations/20261113125403_clowder_rebrand/migration.sql",
);

describe("rename to Clowder", () => {
    const databaseName = `clowder_rebrand_${randomUUID().replaceAll("-", "")}`;
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;

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
            "o@example.test",
        );

        await db.$client.query(
            `INSERT INTO clusters (id, name, sidecar_url, sidecar_token, organization_id, created_at, updated_at)
             VALUES ($1, 'Cluster', 'http://sidecar', 'token', $2, now(), now())`,
            [clusterId, organizationId],
        );
        await db.$client.query(
            "INSERT INTO projects (id, name, cluster_id, created_at, updated_at) VALUES ($1, 'P', $2, now(), now())",
            [projectId, clusterId],
        );
        await db.$client.query(
            "INSERT INTO resources (id, name, slug, project_id, created_at, updated_at) VALUES ($1, 'R', 'r-slug', $2, now(), now())",
            [resourceId, projectId],
        );
    }, 30_000);

    afterAll(async () => {
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    it("renames only actual uses of the built-in variables and the extension key", async () => {
        const spec = [
            "# Mentions ${STOAT_DOMAIN} in a comment, which is harmless either way.",
            "services:",
            "  db:",
            "    image: registry.example/x-stoat/app:1",
            "    x-stoat: { engine: postgres }",
            "    environment:",
            "      HOST: ${STOAT_DOMAIN}",
            "      PREFIX: $STOAT_PREFIX-${STOAT_RESOURCE_ID:-none}",
            "      ADJACENT: $STOAT_PREFIX$STOAT_RESOURCE_ID$$$STOAT_DOMAIN",
            "      EXTRA: ${STOAT_DOMAIN_EXTRA}",
            "      KEEP: ${MY_STOAT_DOMAIN}",
            "      LITERAL: $${STOAT_DOMAIN}",
            "      STOAT_DOMAIN: container-env-key",
            "",
        ].join("\n");

        const env = [
            "A=1",
            "STOAT_DOMAIN=custom.test",
            "HOST=${STOAT_DOMAIN}",
            "URL={{ db.STOAT_PREFIX }}.${STOAT_DOMAIN}",
            "STOAT_OTHER=1",
            "",
        ].join("\n");

        await db.$client.query(
            "UPDATE resources SET spec = $1, settings = $2::jsonb, draft_config_files = $3::jsonb WHERE id = $4",
            [
                spec,
                JSON.stringify({ env, prefixNames: true }),
                JSON.stringify({ "app.conf": "url http://x-stoat: ${STOAT_DOMAIN}" }),
                resourceId,
            ],
        );

        await db.$client.query(readFileSync(MIGRATION, "utf8"));

        const { rows } = await db.$client.query(
            "SELECT spec, settings, draft_config_files FROM resources WHERE id = $1",
            [resourceId],
        );

        expect(rows[0]).toEqual({
            spec: [
                "# Mentions ${CLOWDER_DOMAIN} in a comment, which is harmless either way.",
                "services:",
                "  db:",
                "    image: registry.example/x-stoat/app:1",
                "    x-clowder: { engine: postgres }",
                "    environment:",
                "      HOST: ${CLOWDER_DOMAIN}",
                "      PREFIX: $CLOWDER_PREFIX-${CLOWDER_RESOURCE_ID:-none}",
                "      ADJACENT: $CLOWDER_PREFIX$CLOWDER_RESOURCE_ID$$$CLOWDER_DOMAIN",
                "      EXTRA: ${STOAT_DOMAIN_EXTRA}",
                "      KEEP: ${MY_STOAT_DOMAIN}",
                "      LITERAL: $${STOAT_DOMAIN}",
                "      STOAT_DOMAIN: container-env-key",
                "",
            ].join("\n"),
            settings: {
                env: [
                    "A=1",
                    "CLOWDER_DOMAIN=custom.test",
                    "HOST=${CLOWDER_DOMAIN}",
                    "URL={{ db.CLOWDER_PREFIX }}.${CLOWDER_DOMAIN}",
                    "STOAT_OTHER=1",
                    "",
                ].join("\n"),
                prefixNames: true,
            },
            draft_config_files: { "app.conf": "url http://x-stoat: ${STOAT_DOMAIN}" },
        });
    });
});

describe("legacy Compose names", () => {
    it.each([
        ["services:\n  a:\n    environment:\n      HOST: ${STOAT_DOMAIN}\n"],
        ["services:\n  a:\n    image: app:$STOAT_PREFIX\n"],
        ["services:\n  a:\n    x-stoat: { engine: postgres }\n"],
    ])("rejects %j", (compose) => {
        expect(usesLegacyNames(compose)).toBe(true);
    });

    it.each([
        ["services:\n  a:\n    environment:\n      HOST: ${STOAT_DOMAIN_EXTRA}\n"],
        ["# Renamed STOAT_DOMAIN and x-stoat to CLOWDER_DOMAIN.\nservices:\n  a: { image: app }\n"],
        ["services:\n  a:\n    image: registry.example/x-stoat/app:1\n"],
        ["services:\n  a:\n    environment:\n      LITERAL: $${STOAT_DOMAIN}\n"],
        ["services:\n  a:\n    environment:\n      HOST: ${CLOWDER_DOMAIN}\n"],
    ])("accepts %j", (compose) => {
        expect(usesLegacyNames(compose)).toBe(false);
    });
});
