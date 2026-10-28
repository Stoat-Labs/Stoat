import { sql } from "drizzle-orm";
import * as t from "drizzle-orm/pg-core";
import { encryptedText } from "../secret-column";
import { resourceSlug } from "../slug";
import { organization, user } from "./auth";

export type MonitoringStorage = { type: "volume" | "bind"; source: string };

export const instanceSettings = t.pgTable(
    "instance_settings",
    {
        id: t.integer("id").primaryKey().default(1),
        signupsEnabled: t.boolean("signups_enabled").notNull().default(false),
    },
    (table) => [t.check("instance_settings_singleton", sql`${table.id} = 1`)],
);

export const userSettings = t.pgTable("user_settings", {
    userId: t
        .text("user_id")
        .primaryKey()
        .references(() => user.id, { onDelete: "cascade" }),
    canvasMode: t.boolean("canvas_mode").notNull().default(true),
});

export type ClusterInitializationConfiguration = {
    /** Uncloud machine name. Legacy rows may still hold an ID; Uncloud accepts either. */
    machine: string;
    retentionDays: number;
    /** Fixed managed volumes; omitted in new requests and defaulted server-side. */
    greptimeStorage?: MonitoringStorage;
    alloyStorage?: MonitoringStorage;
};

export const clusters = t.pgTable(
    "clusters",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        sidecarUrl: t.text("sidecar_url").notNull(),
        sidecarToken: encryptedText("sidecar_token", "sidecar-token").notNull(),
        greptimeUrl: t.text("greptime_url"),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        initializedAt: t.timestamp("initialised_at", { withTimezone: true }),
        initializationRequestedAt: t.timestamp("initialization_requested_at", {
            withTimezone: true,
        }),
        initializationStatus: t.text("initialization_status").notNull().default("uninitialized"),
        initializationError: t.text("initialization_error"),
        initializationConfiguration: t
            .jsonb("initialization_configuration")
            .$type<ClusterInitializationConfiguration>(),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("clusters_organization_idx").on(table.organizationId)],
);

// Card and frame positions on the project canvas, keyed by node id.
export type CanvasLayout = Record<string, { x: number; y: number }>;

export const projects = t.pgTable(
    "projects",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        description: t.text("description"),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        isInternal: t.boolean("is_internal").default(false),
        canvasLayout: t.jsonb("canvas_layout").$type<CanvasLayout>(),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("projects_cluster_idx").on(table.clusterId)],
);

// Railway's starred projects, per user.
export const projectFavorites = t.pgTable(
    "project_favorites",
    {
        userId: t
            .text("user_id")
            .notNull()
            .references(() => user.id, { onDelete: "cascade" }),
        projectId: t
            .uuid("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
    },
    (table) => [
        t.primaryKey({ columns: [table.userId, table.projectId] }),
        t.index("project_favorites_project_idx").on(table.projectId),
    ],
);

export type GitAccount = { id: string; login: string; name: string | null };

export type GitKnownRepository = { url: string; name: string; defaultBranch: string };

export const gitOAuthProviders = t.pgTable(
    "git_oauth_providers",
    {
        id: t.text("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<"github" | "forgejo">().notNull(),
        serverUrl: t.text("server_url").notNull(),
        clientId: t.text("client_id").notNull(),
        encryptedClientSecret: t.text("encrypted_client_secret").notNull(),
        active: t.boolean("active").notNull().default(true),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("git_oauth_providers_organization_idx").on(table.organizationId)],
);

export const gitConnections = t.pgTable(
    "git_connections",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<"github" | "forgejo" | "generic">().notNull(),
        serverUrl: t.text("server_url").notNull(),
        authType: t.text("auth_type").$type<"token" | "oauth">().notNull().default("token"),
        account: t.jsonb("account").$type<GitAccount>(),
        repositories: t.jsonb("repositories").$type<GitKnownRepository[]>().notNull().default([]),
        encryptedCredentials: t.text("encrypted_credentials"),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [t.index("git_connections_organization_idx").on(table.organizationId)],
);

export type ResourceGitSource = {
    repositoryUrl: string;
    branch: string;
    path: string;
    revision: string;
    // The commit message of `revision`.
    message: string;
    // Object ids at `revision`: the Compose file's blob and the watched directory's tree.
    // A draft whose blob id differs from `blob` has changes that are not in Git yet.
    blob: string;
    tree: string;
    // Redeploy when a push changes the tree at `watchPath` ("." is the repository root).
    autoDeploy: boolean;
    watchPath: string;
};

export const resources = t.pgTable(
    "resources",
    {
        id: t.uuid("id").primaryKey(),
        name: t.text("name").notNull(),
        // Permanent prefix of its service and volume names; see `resourceSlug`.
        slug: t
            .text("slug")
            .notNull()
            .$defaultFn(() => resourceSlug()),
        description: t.text("description"),
        icon: t.text("icon"),
        type: t.text("type").default("compose"),
        // Last successfully deployed source; edits are saved separately.
        spec: t.text("spec"),
        draftSpec: t.text("draft_spec"),
        // Edited Git config files (`configs.*.file`, as written in Compose) not committed yet;
        // the next deploy commits them with the draft.
        draftConfigFiles: t.jsonb("draft_config_files").$type<Record<string, string>>(),
        // Staged for deletion: removed when the staged changes are applied, cleared by discard.
        pendingDelete: t.boolean("pending_delete").notNull().default(false),
        settings: t.jsonb("settings"),
        // Migration makes this FK deferred so organization-wide cascades can finish.
        gitConnectionId: t
            .uuid("git_connection_id")
            .references(() => gitConnections.id, { onDelete: "no action" }),
        gitSource: t.jsonb("git_source").$type<ResourceGitSource>(),
        projectId: t
            .uuid("project_id")
            .notNull()
            .references(() => projects.id, { onDelete: "cascade" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.index("resources_project_idx").on(table.projectId),
        t.index("resources_git_connection_idx").on(table.gitConnectionId),
        t.uniqueIndex("resources_slug_idx").on(table.slug),
    ],
);

// Private provisioning state. Never return this table through resource/project APIs.
export const clusterMonitoring = t.pgTable("cluster_monitoring", {
    clusterId: t
        .uuid("cluster_id")
        .primaryKey()
        .references(() => clusters.id, { onDelete: "cascade" }),
    projectId: t
        .uuid("project_id")
        .notNull()
        .unique()
        .references(() => projects.id, { onDelete: "cascade" }),
    resourceId: t
        .uuid("resource_id")
        .notNull()
        .unique()
        .references(() => resources.id, { onDelete: "cascade" }),
    encryptedPassword: t.text("encrypted_password").notNull(),
    // MONITORING_VERSION of the last successful deploy; null predates versioning.
    templateVersion: t.integer("template_version"),
});

export type DeploymentStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

// Where a resource deployment came from. "docker" is a Compose edited in Stoat, without Git.
export type DeploymentMetadata = {
    source: "forgejo" | "github" | "git" | "docker";
    trigger: "manual" | "webhook" | "poll";
    commit?: { sha: string; message: string };
};

export const deployments = t.pgTable(
    "deployments",
    {
        id: t.uuid("id").primaryKey(),
        clusterId: t
            .uuid("cluster_id")
            .notNull()
            .references(() => clusters.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        resourceId: t.uuid("resource_id").references(() => resources.id, { onDelete: "cascade" }),
        status: t.text("status").notNull().default("queued"),
        // Deterministic effect-mq job id (`${clusterId}:${requestId}`), used by
        // the worker to attach progress to the right deployment.
        jobId: t.text("job_id").notNull().unique(),
        // Compose spec captured at deploy time. Null for cluster initialization.
        spec: t.text("spec"),
        // Null for cluster initialization.
        metadata: t.jsonb("metadata").$type<DeploymentMetadata>(),
        configuration: t.jsonb("configuration").$type<ClusterInitializationConfiguration>(),
        error: t.text("error"),
        progress: t.smallint("progress").notNull().default(0),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
        finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    },
    (table) => [
        t.index("deployments_cluster_idx").on(table.clusterId, table.createdAt.desc()),
        // Latest deployment per resource (status badges, history, removal checks).
        t.index("deployments_resource_idx").on(table.resourceId, table.createdAt.desc()),
        // The outbox sweep reads queued rows every few seconds.
        t
            .index("deployments_queued_idx")
            .on(table.name)
            .where(sql`${table.status} = 'queued'`),
    ],
);

export const deploymentLogs = t.pgTable(
    "deployment_logs",
    {
        id: t.bigserial("id", { mode: "number" }).primaryKey(),
        deploymentId: t
            .uuid("deployment_id")
            .notNull()
            .references(() => deployments.id, { onDelete: "cascade" }),
        stream: t.text("stream").notNull().default("build"),
        text: t.text("text").notNull(),
        metadata: t
            .jsonb("metadata")
            .$type<{ level?: "info" | "debug" | "error"; event?: string }>()
            .notNull()
            .default({}),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
    },
    (table) => [t.index("deployment_logs_deployment_idx").on(table.deploymentId, table.id)],
);

// Private deploy inputs (naming prefix, env, recreate). The Compose spec lives on
// deployments.spec so every deployment row carries what it deployed.
export const resourceDeploymentInputs = t.pgTable("resource_deployment_inputs", {
    deploymentId: t
        .uuid("deployment_id")
        .primaryKey()
        .references(() => deployments.id, { onDelete: "cascade" }),
    prefix: t.text("prefix").notNull(),
    env: t.text("env").notNull().default(""),
    recreate: t.boolean("recreate").notNull().default(false),
    // Contents of relative `configs.*.file` paths read from Git, keyed as written in the Compose file.
    configFiles: t.jsonb("config_files").$type<Record<string, string>>().notNull().default({}),
});

// Mirrors `S3ProviderId` in @stoat/s3; the check constraint below keeps the database honest.
export type S3Provider = "generic" | "rustfs" | "r2";

// Account-level provider access; buckets are provisioned as project resources.
export const s3Connections = t.pgTable(
    "s3_connections",
    {
        id: t.uuid("id").primaryKey(),
        organizationId: t
            .text("organization_id")
            .notNull()
            .references(() => organization.id, { onDelete: "cascade" }),
        name: t.text("name").notNull(),
        provider: t.text("provider").$type<S3Provider>().notNull(),
        // R2 derives its endpoint from the account ID.
        endpoint: t.text("endpoint").notNull(),
        region: t.text("region").notNull().default("us-east-1"),
        forcePathStyle: t.boolean("force_path_style").notNull().default(false),
        // Encrypted S3 access-key/secret-key pair. R2 derives it from the API token.
        encryptedCredentials: t.text("encrypted_credentials").notNull(),
        // Provider's account identifier; R2 uses the Cloudflare account ID.
        providerAccountId: t.text("provider_account_id"),
        // Provider management API token, used to mint per-bucket tokens.
        encryptedApiToken: t.text("encrypted_api_token"),
        lastTestedAt: t.timestamp("last_tested_at", { withTimezone: true }),
        lastTestStatus: t.text("last_test_status").$type<"success" | "failure">(),
        lastTestError: t.text("last_test_error"),
        version: t.integer("version").notNull().default(1),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.index("s3_connections_organization_idx").on(table.organizationId),
        t.unique("s3_connections_organization_name_uidx").on(table.organizationId, table.name),
        t.check(
            "s3_connections_provider_check",
            sql`${table.provider} in ('generic', 'rustfs', 'r2')`,
        ),
        t.check(
            "s3_connections_provider_account_check",
            sql`(${table.provider} = 'r2') = (
                ${table.providerAccountId} is not null and ${table.encryptedApiToken} is not null
            )`,
        ),
        t.check(
            "s3_connections_test_status_check",
            sql`${table.lastTestStatus} in ('success', 'failure') or ${table.lastTestStatus} is null`,
        ),
    ],
);

export type S3BucketStatus = "provisioning" | "ready" | "failed" | "deleting";

// Written by the HealthCheck job; null until a bucket is first measured.
export type S3BucketMetadata = {
    /** Total bytes across every object. */
    size: number;
    objects: number;
    /** When the provider took this snapshot (ISO); provider usage APIs lag behind writes. */
    measuredAt: string;
};

// Private state of `bucket` resources. Never return this table through resource/project APIs.
export const s3Buckets = t.pgTable(
    "s3_buckets",
    {
        resourceId: t
            .uuid("resource_id")
            .primaryKey()
            .references(() => resources.id, { onDelete: "cascade" }),
        // No cascade: deleting a connection would lose the credentials needed to revoke keys.
        // Migration makes this FK deferred so organization-wide cascades can finish.
        connectionId: t
            .uuid("connection_id")
            .notNull()
            .references(() => s3Connections.id, { onDelete: "no action" }),
        name: t.text("name").notNull(),
        status: t.text("status").$type<S3BucketStatus>().notNull(),
        // Durable outbox: a new request time is a new job, so retries are not deduplicated away.
        requestedAt: t.timestamp("requested_at", { withTimezone: true }).notNull(),
        error: t.text("error"),
        // Provider key ID and its encrypted key pair; null when the provider shares connection keys.
        keyId: t.text("key_id"),
        encryptedCredentials: t.text("encrypted_credentials"),
        metadata: t.jsonb("metadata").$type<S3BucketMetadata>(),
        // Storage limit in bytes; null means unlimited. Enforced only where the provider supports it.
        quota: t.bigint("quota", { mode: "number" }),
        createdAt: t
            .timestamp("created_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date()),
        updatedAt: t
            .timestamp("updated_at", { withTimezone: true })
            .notNull()
            .$defaultFn(() => new Date())
            .$onUpdate(() => new Date()),
    },
    (table) => [
        t.unique("s3_buckets_connection_name_uidx").on(table.connectionId, table.name),
        t.check(
            "s3_buckets_status_check",
            sql`${table.status} in ('provisioning', 'ready', 'failed', 'deleting')`,
        ),
    ],
);

export * from "./auth";
