import { createDb } from "@clowder/db";
import { decryptColumnValue, encryptColumnValue } from "@clowder/db/secret-column";
import { decryptS3Secret, encryptS3Secret } from "@clowder/s3/secrets";
import { decryptMonitoringPassword, encryptMonitoringPassword } from "@clowder/workflows/secrets";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
    decryptGitOAuthClientSecret,
    encryptGitOAuthClientSecret,
} from "../../packages/api/src/git/oauth-secrets";
import { decryptGitCredentials, encryptGitCredentials } from "../../packages/api/src/git/secrets";
import { rekeySecrets } from "../../packages/api/src/rebrand";
import { dropTestDatabase } from "../database";
import { insertUserWithOrganization } from "../users";

const MIGRATION = resolve(
    "packages/db/src/migrations/20261113125403_clowder_rebrand/migration.sql",
);

describe("rename to Clowder", () => {
    const databaseName = `clowder_rebrand_${randomUUID().replaceAll("-", "")}`;
    const secret = "rebrand-test-secret-0123456789abcdef";
    const clusterId = randomUUID();
    const projectId = randomUUID();
    const resourceId = randomUUID();
    const gitId = randomUUID();
    const oauthId = randomUUID();
    const s3Id = randomUUID();
    let organizationId: string;
    let admin: ReturnType<typeof createDb>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
        vi.stubEnv("APP_SECRET", secret);
        admin = createDb({ DATABASE_URL: process.env.DATABASE_URL! });
        await admin.$client.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = `/${databaseName}`;
        db = createDb({ DATABASE_URL: url.toString() });
        await migrate(db, { migrationsFolder: resolve("packages/db/src/migrations") });
        organizationId = await insertUserWithOrganization(db, "owner", "Owner", "o@example.test");
    }, 30_000);

    afterAll(async () => {
        vi.unstubAllEnvs();
        await db?.$client.end();

        if (admin) {
            await dropTestDatabase(admin, databaseName);
            await admin.$client.end();
        }
    });

    it("re-encrypts every secret stored under the legacy labels, once", async () => {
        const oauthScope = {
            organizationId,
            id: oauthId,
            provider: "github",
            serverUrl: "https://github.com",
            clientId: "client",
        };

        const s3Scope = {
            kind: "connection-credentials" as const,
            organizationId,
            connectionId: s3Id,
        };

        const bucketScope = { kind: "bucket-credentials" as const, resourceId };

        await db.$client.query(
            `INSERT INTO clusters (id, name, sidecar_url, sidecar_token, organization_id, created_at, updated_at)
             VALUES ($1, 'Cluster', 'http://sidecar', $2, $3, now(), now())`,
            [clusterId, encryptColumnValue("sidecar-token", "token", "stoat"), organizationId],
        );
        await db.$client.query(
            "INSERT INTO projects (id, name, cluster_id, created_at, updated_at) VALUES ($1, 'P', $2, now(), now())",
            [projectId, clusterId],
        );
        await db.$client.query(
            "INSERT INTO resources (id, name, slug, project_id, created_at, updated_at) VALUES ($1, 'R', 'r-slug', $2, now(), now())",
            [resourceId, projectId],
        );
        await db.$client.query(
            "INSERT INTO cluster_monitoring (cluster_id, project_id, resource_id, encrypted_password) VALUES ($1, $2, $3, $4)",
            [
                clusterId,
                projectId,
                resourceId,
                encryptMonitoringPassword("greptime", secret, clusterId, "stoat"),
            ],
        );
        await db.$client.query(
            `INSERT INTO git_connections (id, organization_id, name, provider, server_url, encrypted_credentials, created_at, updated_at)
             VALUES ($1, $2, 'Git', 'github', 'https://github.com', $3, now(), now())`,
            [
                gitId,
                organizationId,
                encryptGitCredentials(
                    { password: "pat" },
                    { organizationId, connectionId: gitId },
                    "stoat",
                ),
            ],
        );
        await db.$client.query(
            `INSERT INTO git_oauth_providers (id, organization_id, name, provider, server_url, client_id, encrypted_client_secret, created_at)
             VALUES ($1, $2, 'OAuth', 'github', 'https://github.com', 'client', $3, now())`,
            [oauthId, organizationId, encryptGitOAuthClientSecret("shh", oauthScope, "stoat")],
        );
        await db.$client.query(
            `INSERT INTO s3_connections (id, organization_id, name, provider, endpoint, encrypted_credentials, created_at, updated_at)
             VALUES ($1, $2, 'S3', 'rustfs', 'http://s3', $3, now(), now())`,
            [s3Id, organizationId, encryptS3Secret("keys", s3Scope, "stoat")],
        );
        await db.$client.query(
            `INSERT INTO s3_buckets (resource_id, connection_id, name, status, requested_at, key_id, encrypted_credentials, created_at, updated_at)
             VALUES ($1, $2, 'bucket', 'ready', now(), 'stoat-key', $3, now(), now())`,
            [resourceId, s3Id, encryptS3Secret("bucket-keys", bucketScope, "stoat")],
        );

        expect(await rekeySecrets(db)).toBe(6);
        // Everything already uses the new labels, so a second run is a no-op.
        expect(await rekeySecrets(db)).toBe(0);

        const value = async (query: string) =>
            String(Object.values((await db.$client.query(query)).rows[0] ?? {})[0]);

        expect(
            decryptColumnValue("sidecar-token", await value("SELECT sidecar_token FROM clusters")),
        ).toBe("token");
        expect(
            decryptMonitoringPassword(
                await value("SELECT encrypted_password FROM cluster_monitoring"),
                secret,
                clusterId,
            ),
        ).toBe("greptime");
        expect(
            decryptGitCredentials(
                await value("SELECT encrypted_credentials FROM git_connections"),
                { organizationId, connectionId: gitId },
            ),
        ).toEqual({ password: "pat" });
        expect(
            decryptGitOAuthClientSecret(
                await value("SELECT encrypted_client_secret FROM git_oauth_providers"),
                oauthScope,
            ),
        ).toBe("shh");
        expect(
            decryptS3Secret(
                await value("SELECT encrypted_credentials FROM s3_connections"),
                s3Scope,
            ),
        ).toBe("keys");
        expect(
            decryptS3Secret(
                await value("SELECT encrypted_credentials FROM s3_buckets"),
                bucketScope,
            ),
        ).toBe("bucket-keys");
    });

    it("leaves a secret that no label opens as it was", async () => {
        await db.$client.query("UPDATE clusters SET sidecar_token = $1 WHERE id = $2", [
            "enc:v1:AAAA.AAAA.AAAA.AAAA",
            clusterId,
        ]);

        expect(await rekeySecrets(db)).toBe(0);
    });

    it("renames built-in variables in stored Compose and keeps monitoring on its volumes", async () => {
        await db.$client.query(
            `UPDATE resources SET
                spec = $1,
                settings = $2::jsonb
             WHERE id = $3`,
            [
                "services:\n  db:\n    x-stoat: { engine: postgres }\n    environment:\n      HOST: ${STOAT_DOMAIN}\n      KEEP: ${MY_STOAT_DOMAIN}\n",
                JSON.stringify({
                    env: "URL={{ db.STOAT_PREFIX }}.${STOAT_DOMAIN}\nSTOAT_OTHER=1\n",
                }),
                resourceId,
            ],
        );
        await db.$client.query(
            `UPDATE clusters SET
                initialization_configuration = '{"machine": "m1", "retentionDays": 14}'::jsonb,
                greptime_url = 'http://stoat-monitoring-greptimedb.internal:4006'`,
        );

        await db.$client.query(readFileSync(MIGRATION, "utf8"));

        const { rows } = await db.$client.query(
            `SELECT r.spec, r.settings, c.initialization_configuration, c.greptime_url
             FROM resources r, clusters c WHERE r.id = $1`,
            [resourceId],
        );

        expect(rows[0]).toEqual({
            spec: "services:\n  db:\n    x-clowder: { engine: postgres }\n    environment:\n      HOST: ${CLOWDER_DOMAIN}\n      KEEP: ${MY_STOAT_DOMAIN}\n",
            settings: { env: "URL={{ db.CLOWDER_PREFIX }}.${CLOWDER_DOMAIN}\nSTOAT_OTHER=1\n" },
            initialization_configuration: {
                machine: "m1",
                retentionDays: 14,
                greptimeStorage: { type: "volume", source: "stoat-monitoring-greptime" },
                alloyStorage: { type: "volume", source: "stoat-monitoring-alloy" },
            },
            greptime_url: "http://clowder-monitoring-greptimedb.internal:4006",
        });
    });
});
