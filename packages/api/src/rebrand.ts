import { appSecret } from "@clowder/config/env";
import type { Database } from "@clowder/db";
import {
    decryptColumnValue,
    encryptColumnValue,
    isEncryptedColumnValue,
} from "@clowder/db/secret-column";
import { decryptS3Secret, encryptS3Secret } from "@clowder/s3/secrets";
import { decryptMonitoringPassword, encryptMonitoringPassword } from "@clowder/workflows/secrets";
import { decryptGitOAuthClientSecret, encryptGitOAuthClientSecret } from "./git/oauth-secrets";
import { decryptGitCredentials, encryptGitCredentials } from "./git/secrets";

// Every key was derived from the legacy label before the rename to Clowder.
const LEGACY = "stoat";

const CLUSTER_COLUMNS = [
    ["sidecar_token", "sidecar-token"],
    ["provisioning_secrets", "cluster-provisioning"],
    ["pending_machine_key", "cluster-pending-machine"],
] as const;

/** The value encrypted under the current label, or null when it needs no change. */
function rekeyed<T>(stored: string, read: (label?: string) => T, write: (plaintext: T) => string) {
    try {
        read();

        return null;
    } catch {
        // Not readable with the current label: it predates the rename, or was already unreadable.
    }

    try {
        return write(read(LEGACY));
    } catch {
        // Unreadable either way, e.g. APP_SECRET changed long ago. Leave it as it was.
        console.warn(`[rebrand] left an unreadable secret as is (${stored.length} chars).`);

        return null;
    }
}

/**
 * Re-encrypts every secret stored before the rename to Clowder.under the new key
 * labels. Runs in the pre-deploy hook, before the app reads any of them. Safe to run again.
 */
export async function rekeySecrets(db: Database) {
    // The app's own secret check runs here too, so a missing APP_SECRET fails the deploy.
    const secret = appSecret();
    const client = await db.$client.connect();
    let changed = 0;

    const update = async (statement: string, value: string | null, id: string) => {
        if (value === null) return;
        await client.query(statement, [value, id]);
        changed++;
    };

    try {
        await client.query("BEGIN");

        const clusters = await client.query<Record<string, string | null>>(
            "SELECT id, sidecar_token, provisioning_secrets, pending_machine_key FROM clusters FOR UPDATE",
        );

        for (const row of clusters.rows) {
            for (const [column, purpose] of CLUSTER_COLUMNS) {
                const stored = row[column];

                if (!stored || !isEncryptedColumnValue(stored)) continue;
                await update(
                    `UPDATE clusters SET ${column} = $1 WHERE id = $2`,
                    rekeyed(
                        stored,
                        (label) => decryptColumnValue(purpose, stored, label),
                        (plaintext) => encryptColumnValue(purpose, plaintext),
                    ),
                    String(row.id),
                );
            }
        }

        const monitoring = await client.query<{ cluster_id: string; encrypted_password: string }>(
            "SELECT cluster_id, encrypted_password FROM cluster_monitoring FOR UPDATE",
        );

        for (const row of monitoring.rows) {
            await update(
                "UPDATE cluster_monitoring SET encrypted_password = $1 WHERE cluster_id = $2",
                rekeyed(
                    row.encrypted_password,
                    (label) =>
                        decryptMonitoringPassword(
                            row.encrypted_password,
                            secret,
                            row.cluster_id,
                            label,
                        ),
                    (plaintext) => encryptMonitoringPassword(plaintext, secret, row.cluster_id),
                ),
                row.cluster_id,
            );
        }

        const connections = await client.query<{
            id: string;
            organization_id: string;
            encrypted_credentials: string;
        }>(
            "SELECT id, organization_id, encrypted_credentials FROM git_connections WHERE encrypted_credentials IS NOT NULL FOR UPDATE",
        );

        for (const row of connections.rows) {
            const scope = { organizationId: row.organization_id, connectionId: row.id };

            await update(
                "UPDATE git_connections SET encrypted_credentials = $1 WHERE id = $2",
                rekeyed(
                    row.encrypted_credentials,
                    (label) => decryptGitCredentials(row.encrypted_credentials, scope, label),
                    (plaintext) => encryptGitCredentials(plaintext, scope),
                ),
                row.id,
            );
        }

        const oauth = await client.query<{
            id: string;
            organization_id: string;
            provider: string;
            server_url: string;
            client_id: string;
            encrypted_client_secret: string;
        }>(
            "SELECT id, organization_id, provider, server_url, client_id, encrypted_client_secret FROM git_oauth_providers FOR UPDATE",
        );

        for (const row of oauth.rows) {
            const scope = {
                organizationId: row.organization_id,
                id: row.id,
                provider: row.provider,
                serverUrl: row.server_url,
                clientId: row.client_id,
            };

            await update(
                "UPDATE git_oauth_providers SET encrypted_client_secret = $1 WHERE id = $2",
                rekeyed(
                    row.encrypted_client_secret,
                    (label) =>
                        decryptGitOAuthClientSecret(row.encrypted_client_secret, scope, label),
                    (plaintext) => encryptGitOAuthClientSecret(plaintext, scope),
                ),
                row.id,
            );
        }

        const s3 = await client.query<{
            id: string;
            organization_id: string;
            encrypted_credentials: string;
            encrypted_api_token: string | null;
        }>(
            "SELECT id, organization_id, encrypted_credentials, encrypted_api_token FROM s3_connections FOR UPDATE",
        );

        for (const row of s3.rows) {
            const owner = { organizationId: row.organization_id, connectionId: row.id };
            const credentials = { kind: "connection-credentials" as const, ...owner };
            const token = { kind: "connection-api-token" as const, ...owner };

            await update(
                "UPDATE s3_connections SET encrypted_credentials = $1 WHERE id = $2",
                rekeyed(
                    row.encrypted_credentials,
                    (label) => decryptS3Secret(row.encrypted_credentials, credentials, label),
                    (plaintext) => encryptS3Secret(plaintext, credentials),
                ),
                row.id,
            );

            const apiToken = row.encrypted_api_token;

            if (apiToken)
                await update(
                    "UPDATE s3_connections SET encrypted_api_token = $1 WHERE id = $2",
                    rekeyed(
                        apiToken,
                        (label) => decryptS3Secret(apiToken, token, label),
                        (plaintext) => encryptS3Secret(plaintext, token),
                    ),
                    row.id,
                );
        }

        const buckets = await client.query<{ resource_id: string; encrypted_credentials: string }>(
            "SELECT resource_id, encrypted_credentials FROM s3_buckets WHERE encrypted_credentials IS NOT NULL FOR UPDATE",
        );

        for (const row of buckets.rows) {
            const scope = { kind: "bucket-credentials" as const, resourceId: row.resource_id };

            await update(
                "UPDATE s3_buckets SET encrypted_credentials = $1 WHERE resource_id = $2",
                rekeyed(
                    row.encrypted_credentials,
                    (label) => decryptS3Secret(row.encrypted_credentials, scope, label),
                    (plaintext) => encryptS3Secret(plaintext, scope),
                ),
                row.resource_id,
            );
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    return changed;
}
