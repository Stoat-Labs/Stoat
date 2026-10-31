import { ORPCError } from "@orpc/server";
import type { Database } from "@stoat/db";
import { deployments, projects, resourceDeploymentInputs, resources } from "@stoat/db/schema/index";
import { resourceSlug } from "@stoat/db/slug";
import { unwrap, type UcClient } from "@stoat/uncloud";
import {
    composeVariables,
    prefixName,
    resourceComposePrefix,
    resourceEnv,
    serviceVariable,
} from "@stoat/workflows/compose";
import { parseEnvLines, setEnvVariable } from "@stoat/workflows/env-lines";
import {
    referencedResourceIds,
    referenceKeys,
    referenceTargets,
    resolveReferences,
} from "@stoat/workflows/references";
import { eq, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import * as v from "valibot";
import YAML, { isSeq } from "yaml";

import { organizationProcedure, resourceMiddleware, uncloudMiddleware } from "../..";
import { postgresService } from "../../compose";
import { databaseEngine } from "../../databases";
import { composeServices } from "../../project-graph";

type Resource = typeof resources.$inferSelect;

const PGDOG_IMAGE = "ghcr.io/pgdogdev/pgdog";

// Configs, since PgDog reads only TOML files; `${...}` resolves from the pooler's Variables at deploy.
const pgdogCompose = `services:
    pgdog:
        image: ${PGDOG_IMAGE}:v0.1.61
        restart: unless-stopped
        configs:
            - source: pgdog
              target: /pgdog/pgdog.toml
            - source: pgdog-users
              target: /pgdog/users.toml

configs:
    pgdog:
        content: |
            [general]
            host = "0.0.0.0"
            port = 6432

            [[databases]]
            name = "\${POSTGRES_DB}"
            host = "\${POSTGRES_HOST}"
            port = 5432
    pgdog-users:
        content: |
            [[users]]
            name = "\${POSTGRES_USER}"
            database = "\${POSTGRES_DB}"
            password = "\${POSTGRES_PASSWORD}"
`;

const STATEMENTS_LIBRARY = "shared_preload_libraries=pg_stat_statements";

const postgresInput = v.object({
    clusterId: v.pipe(v.string(), v.uuid()),
    projectId: v.pipe(v.string(), v.uuid()),
    resourceId: v.pipe(v.string(), v.uuid()),
});

/** The resource's Variables resolved like a deploy, so referenced and interpolated values are real. */
export async function postgresEnv(
    db: Database,
    clusterId: string,
    resource: Resource,
    compose: string,
): Promise<Record<string, string | undefined>> {
    const envText = resourceEnv(resource);

    try {
        const ids = referencedResourceIds(envText);
        const targets = ids.length > 0 ? await referenceTargets(db, clusterId, ids) : [];
        const references = resolveReferences(envText, targets, undefined, resource.id);

        const [project] = await db
            .select({ name: projects.name })
            .from(projects)
            .where(eq(projects.id, resource.projectId));

        // `STOAT_PROJECT_*` / `STOAT_RESOURCE_*` resolve like the deploy does.
        return composeVariables(
            compose,
            envText,
            resourceComposePrefix(resource),
            undefined,
            references,
            {
                projectId: resource.projectId,
                projectName: project?.name ?? "",
                resourceId: resource.id,
                resourceName: resource.name,
            },
        );
    } catch {
        return parseEnv(envText);
    }
}

// psql's unaligned output with control characters as separators, so values may hold newlines.
const FIELD = "\x1f";

const RECORD = "\x1e";

const NULL = "\x1d";

// Runs in the container over the local socket, which the image trusts: no password. `$user` is the
// first role given that exists: the Variable's user, then the prefixed service name deploys gave
// it while they still rewrote environment values that matched a service name.
const pickUser = `db="\${POSTGRES_DB:-\${POSTGRES_USER:-postgres}}"
for user in "$@"; do psql -X -U "$user" -d "$db" -c "" >/dev/null 2>&1 && break; done`;

const psql = `${pickUser}
PGOPTIONS="-c statement_timeout=30000" exec psql -X -q -v ON_ERROR_STOP=1 -A -P footer=on \
-F "$(printf '\\037')" -R "$(printf '\\036')" -P null="$(printf '\\035')" -U "$user" -d "$db"`;

// Renames that old role to the Variable's user ($1) through a temporary superuser, since a session
// can't rename its own role. SCRAM passwords survive a rename; MD5 ones would be cleared.
const renameRole = `${pickUser}
[ "$user" = "$1" ] && exit 0
q() { psql -X -q -v ON_ERROR_STOP=1 -At "$@"; }
scram=$(printf '%s' "SELECT rolpassword LIKE 'SCRAM-SHA-256\\$%' FROM pg_authid WHERE rolname = current_user" | q -U "$user" -d "$db")
[ "$scram" = t ] || { echo "The role's password isn't stored as SCRAM-SHA-256, so renaming it would clear it." >&2; exit 1; }
printf '%s' 'CREATE ROLE stoat_rename SUPERUSER LOGIN' | q -U "$user" -d "$db" || exit 1
printf '%s' 'ALTER ROLE :"old" RENAME TO :"new"' | q -U stoat_rename -d "$db" -v old="$user" -v new="$1"
status=$?
owner="$1"; [ $status -eq 0 ] || owner="$user"
printf '%s' 'DROP ROLE stoat_rename' | q -U "$owner" -d "$db"
exit $status`;

/**
 * The last result in psql's output: each SELECT prints `header␞row␞…␞(N rows)\n`. `-q` leaves out
 * command tags, so output after the last footer is only from statements that return no rows.
 */
export function parsePsqlOutput(stdout: string) {
    const footers = [...stdout.matchAll(/\x1e\((\d+) rows?\)\n/gu)];
    const last = footers.at(-1);

    if (!last || stdout.slice(last.index + last[0].length).trim())
        return { columns: [], rows: [], command: "Done" };

    const count = Number(last[1]);

    const records = stdout
        .slice(0, last.index)
        .split(RECORD)
        .slice(-(count + 1));

    // The header follows whatever an earlier statement printed on the same line run.
    const header = (records[0] ?? "").split("\n").at(-1) ?? "";

    return {
        columns: header.split(FIELD),
        rows: records
            .slice(1)
            .map((record) => record.split(FIELD).map((value) => (value === NULL ? null : value))),
        command: `SELECT ${count}`,
    };
}

/** Runs `script` in the deployed PostgreSQL container with the roles `$user` may be. */
async function execPostgres(
    db: Database,
    uc: UcClient,
    clusterId: string,
    resource: Resource,
    script: string,
    stdin: string,
) {
    let service;

    try {
        service = resource.spec ? postgresService(resource.spec) : undefined;
    } catch {
        service = undefined;
    }

    if (databaseEngine(resource) !== "postgresql" || !service)
        throw new ORPCError("PRECONDITION_FAILED", { message: "Deploy the database first." });

    const name = prefixName(service.name, resourceComposePrefix(resource));
    const env = await postgresEnv(db, clusterId, resource, resource.spec ?? "");

    const { containers } = await unwrap(
        uc.GET("/api/v1/services/{id}", { params: { path: { id: name } } }),
    );

    const container = containers
        .map(({ container }) => v.parse(containerSchema, container))
        .find(({ State }) => State?.Running);

    if (!container)
        throw new ORPCError("PRECONDITION_FAILED", { message: "The database isn't running." });

    const result = await unwrap(
        uc.POST("/api/v1/services/{id}/containers/{container}/exec", {
            params: { path: { id: name, container: container.Id } },
            body: {
                command: ["sh", "-c", script, "sh", env.POSTGRES_USER || "postgres", name],
                stdin,
            },
            signal: AbortSignal.timeout(60_000),
        }),
    );

    if (result.exitCode !== 0)
        throw new ORPCError("BAD_REQUEST", {
            message:
                result.stderr.replaceAll(/psql:<stdin>:\d+: /gu, "").trim() || "The query failed.",
        });

    return result;
}

/** Runs SQL with psql inside the deployed PostgreSQL container, as the database's own user. */
export async function queryPostgres(
    db: Database,
    uc: UcClient,
    clusterId: string,
    resource: Resource,
    query: string,
) {
    const result = await execPostgres(db, uc, clusterId, resource, psql, query);

    if (result.truncated)
        throw new ORPCError("BAD_REQUEST", {
            message: "The result is larger than 1 MiB. Add a LIMIT to see part of it.",
        });

    return parsePsqlOutput(result.stdout);
}

const containerSchema = v.object({
    Id: v.string(),
    State: v.optional(v.nullable(v.object({ Running: v.optional(v.boolean()) }))),
});

/** Sets the password Variable to a plain literal, or refuses when it is a reference or interpolation. */
export function replacePostgresPassword(envText: string, password: string) {
    const current = parseEnvLines(envText).find(({ key }) => key === "POSTGRES_PASSWORD");

    if (!current) return { error: "The database has no POSTGRES_PASSWORD variable." };

    if (current.value.includes("{{") || (current.quote !== "'" && current.value.includes("$")))
        return {
            error: "POSTGRES_PASSWORD references another value. Change it in Variables instead.",
        };

    return { env: setEnvVariable(envText, "POSTGRES_PASSWORD", password) };
}

/** Adds pg_stat_statements to the first service's `command`, keeping any arguments it has. */
export function preloadStatements(compose: string) {
    const document = YAML.parseDocument(compose);
    const service = postgresService(compose);

    if (!service) throw new Error("The Compose file has no PostgreSQL service.");
    const path = ["services", service.name, "command"];
    const command = document.getIn(path, true);

    if (command === undefined) {
        document.setIn(path, document.createNode(["postgres", "-c", STATEMENTS_LIBRARY]));

        return document.toString();
    }

    // A string command is one argument here, enough to see what it preloads.
    const args = [document.getIn(path)].flat();

    if (args.some((arg) => String(arg).includes("pg_stat_statements"))) return compose;

    if (!isSeq(command) || args.some((arg) => String(arg).includes("shared_preload_libraries")))
        throw new Error(
            `The service sets its own command. Add \`-c ${STATEMENTS_LIBRARY}\` to it in Compose.`,
        );

    command.add("-c");
    command.add(STATEMENTS_LIBRARY);

    return document.toString();
}

export const resourcePostgresRouter = {
    /** Runs SQL as the database's own user, last statement's rows as text. */
    queryPostgres: organizationProcedure
        .input(v.object({ ...postgresInput.entries, query: v.pipe(v.string(), v.minLength(1)) }))
        .use(resourceMiddleware)
        .use(uncloudMiddleware)
        .handler(({ context: { db, resource, uc }, input }) =>
            queryPostgres(db, uc, input.clusterId, resource, input.query),
        ),

    /**
     * Renames the database's role to its POSTGRES_USER Variable. Deploys used to give template
     * databases the prefixed service name as their user; Variables and references said otherwise.
     */
    renamePostgresRole: organizationProcedure
        .input(postgresInput)
        .use(resourceMiddleware)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, resource, uc }, input }) => {
            await execPostgres(db, uc, input.clusterId, resource, renameRole, "");
        }),

    /** Changes the role's password on the server, then the Variable, rolling back if the server refuses. */
    regeneratePostgresPassword: organizationProcedure
        .input(postgresInput)
        .use(resourceMiddleware)
        .use(uncloudMiddleware)
        .handler(({ context: { db, uc }, input }) =>
            db.transaction(async (tx) => {
                const [resource] = await tx
                    .select()
                    .from(resources)
                    .where(eq(resources.id, input.resourceId))
                    .for("update");

                if (!resource) throw new ORPCError("NOT_FOUND", { message: "Resource not found." });

                // Hex needs no quoting in SQL or `.env`.
                const password = randomBytes(16).toString("hex");
                const next = replacePostgresPassword(resourceEnv(resource), password);

                if ("error" in next) throw new ORPCError("BAD_REQUEST", { message: next.error });

                await tx
                    .update(resources)
                    .set({
                        settings: sql`coalesce(${resources.settings}, '{}'::jsonb) || jsonb_build_object('env', ${next.env}::text)`,
                    })
                    .where(eq(resources.id, resource.id));

                // Discard restores Variables from these snapshots; the old password must not come back.
                const snapshots = await tx
                    .select({
                        deploymentId: resourceDeploymentInputs.deploymentId,
                        env: resourceDeploymentInputs.env,
                    })
                    .from(resourceDeploymentInputs)
                    .innerJoin(
                        deployments,
                        eq(deployments.id, resourceDeploymentInputs.deploymentId),
                    )
                    .where(eq(deployments.resourceId, resource.id));

                for (const snapshot of snapshots) {
                    const replaced = replacePostgresPassword(snapshot.env, password);

                    if ("env" in replaced)
                        await tx
                            .update(resourceDeploymentInputs)
                            .set({ env: replaced.env })
                            .where(
                                eq(resourceDeploymentInputs.deploymentId, snapshot.deploymentId),
                            );
                }

                // Runs before the new Variable commits, so a refused change keeps the old one.
                await queryPostgres(
                    db,
                    uc,
                    input.clusterId,
                    resource,
                    // Untracked, so pg_stat_statements (shown under Stats) never records the password.
                    `SET pg_stat_statements.track_utility = off; ALTER ROLE CURRENT_USER PASSWORD '${password}'`,
                );
            }),
        ),

    /** Creates pg_stat_statements once the server preloads it, or stages the preload for the next deploy. */
    enableQueryStatistics: organizationProcedure
        .input(postgresInput)
        .use(resourceMiddleware)
        .use(uncloudMiddleware)
        .handler(async ({ context: { db, resource, uc }, input }) => {
            const preloaded = await queryPostgres(
                db,
                uc,
                input.clusterId,
                resource,
                "SHOW shared_preload_libraries",
            ).then(({ rows }) => rows[0]?.[0]?.includes("pg_stat_statements") ?? false);

            if (preloaded) {
                await queryPostgres(
                    db,
                    uc,
                    input.clusterId,
                    resource,
                    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
                );

                return { pendingDeployment: false };
            }

            if (resource.gitSource)
                throw new ORPCError("BAD_REQUEST", {
                    message: `Add \`-c ${STATEMENTS_LIBRARY}\` to the PostgreSQL command in Git.`,
                });

            await db.transaction(async (tx) => {
                const [locked] = await tx
                    .select({ draftSpec: resources.draftSpec, spec: resources.spec })
                    .from(resources)
                    .where(eq(resources.id, resource.id))
                    .for("update");

                const compose = locked?.draftSpec?.trim() ? locked.draftSpec : locked?.spec;

                let draftSpec;

                try {
                    draftSpec = preloadStatements(compose ?? "");
                } catch (error) {
                    throw new ORPCError("BAD_REQUEST", {
                        message: error instanceof Error ? error.message : "Compose can't be read.",
                    });
                }

                await tx.update(resources).set({ draftSpec }).where(eq(resources.id, resource.id));
            });

            return { pendingDeployment: true };
        }),

    /** Adds a draft PgDog resource that pools connections to this database through references. */
    addConnectionPooler: organizationProcedure
        .input(postgresInput)
        .use(resourceMiddleware)
        .handler(async ({ context: { db, resource }, input }) => {
            const [target] = await referenceTargets(db, input.clusterId, [resource.id]);
            let service;

            try {
                service = target ? postgresService(target.draftSpec || target.spec) : undefined;
            } catch {
                service = undefined;
            }

            if (databaseEngine(resource) !== "postgresql" || !target || !service)
                throw new ORPCError("BAD_REQUEST", {
                    message: "Only PostgreSQL databases can be pooled.",
                });

            const keys = referenceKeys(target).map(({ key }) => key);

            if (!keys.includes("POSTGRES_PASSWORD"))
                throw new ORPCError("BAD_REQUEST", {
                    message: "The database has no POSTGRES_PASSWORD variable to connect with.",
                });

            const reference = (key: string, fallback: string) =>
                keys.includes(key) ? `{{ ${resource.id}.${key} }}` : fallback;

            const env = [
                `POSTGRES_HOST={{ ${resource.id}.${serviceVariable(service.name)}_INTERNAL_HOST }}`,
                `POSTGRES_USER=${reference("POSTGRES_USER", "postgres")}`,
                `POSTGRES_PASSWORD=${reference("POSTGRES_PASSWORD", "")}`,
                `POSTGRES_DB=${reference("POSTGRES_DB", reference("POSTGRES_USER", "postgres"))}`,
            ].join("\n");

            return db.transaction(async (tx) => {
                // Locking the database serializes concurrent adds, so only one passes the duplicate check.
                await tx
                    .select({ id: resources.id })
                    .from(resources)
                    .where(eq(resources.id, resource.id))
                    .for("update");

                const siblings = await tx
                    .select()
                    .from(resources)
                    .where(eq(resources.projectId, resource.projectId));

                const existing = siblings.find((row) => {
                    try {
                        return (
                            referencedResourceIds(resourceEnv(row)).includes(resource.id) &&
                            composeServices(
                                row.draftSpec?.trim() ? row.draftSpec : (row.spec ?? ""),
                            ).some(({ image }) => image?.startsWith(`${PGDOG_IMAGE}:`))
                        );
                    } catch {
                        return false;
                    }
                });

                if (existing)
                    throw new ORPCError("CONFLICT", {
                        message: `"${existing.name}" already pools this database.`,
                    });

                const name = `${resource.name} pooler`.slice(0, 100);

                const [created] = await tx
                    .insert(resources)
                    .values({
                        id: randomUUID(),
                        name,
                        slug: resourceSlug(name),
                        type: "compose",
                        projectId: resource.projectId,
                        draftSpec: pgdogCompose,
                        settings: { prefixNames: true, env },
                    })
                    .returning();

                return created!;
            });
        }),
};
