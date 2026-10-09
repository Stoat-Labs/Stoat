import type { Database } from "@stoat/db";
import { parseEnv } from "node:util";
import {
    ComposeVariableError,
    assertNoComposeReference,
    composeVariables,
    resourceComposePrefix,
    resourceEnv,
    type VariableReferences,
} from "./compose";
import { referenceResourceId, VARIABLE_REFERENCE } from "./variable-reference";

export type ReferenceTarget = {
    id: string;
    name: string;
    projectId: string;
    projectName: string;
    // Raw jsonb; read through `resourceEnv` and `resourceComposePrefix`.
    settings: unknown;
    // Last deployed spec, so built-in hosts match what is running.
    spec: string;
};

/**
 * Compose resources a reference may point at: same cluster, never internal projects.
 * The cluster scope is the tenancy boundary, since env text can hold any UUID.
 */
export async function referenceTargets(db: Database, clusterId: string, ids?: string[]) {
    const { rows } = await db.$client.query<ReferenceTarget>(
        `SELECT r.id, r.name, r.project_id AS "projectId", p.name AS "projectName", r.settings,
                coalesce(r.spec, r.draft_spec, '') AS spec
         FROM resources r
         JOIN projects p ON p.id = r.project_id
         WHERE p.cluster_id = $1
           AND p.is_internal IS NOT TRUE
           AND r.type IN ('compose', 'database')
           AND ($2::uuid[] IS NULL OR r.id = ANY($2::uuid[]))
         ORDER BY p.name, r.created_at`,
        [clusterId, ids ?? null],
    );

    return rows;
}

/** Resource ids referenced by `.env` values; comments never count. */
export function referencedResourceIds(envText: string) {
    const ids = new Set<string>();

    for (const value of Object.values(parseEnv(envText)))
        for (const [, id = ""] of (value ?? "").matchAll(VARIABLE_REFERENCE)) {
            const resourceId = referenceResourceId(id);

            if (resourceId) ids.add(resourceId);
        }

    return [...ids];
}

/** Variables a target exposes to references: built-ins plus its own resolved `.env`. */
export function referenceVariables(target: ReferenceTarget, domain?: string) {
    try {
        return composeVariables(
            target.spec,
            resourceEnv(target),
            resourceComposePrefix(target),
            domain,
        );
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Invalid variables.";

        throw new ComposeVariableError(`Unable to read variables from "${target.name}": ${reason}`);
    }
}

/** Resolve every `{{ <resourceId>.<KEY> }}` in `envText` (owned by `resourceId`) against `targets`. */
export function resolveReferences(
    envText: string,
    targets: ReferenceTarget[],
    domain?: string,
    resourceId?: string,
): VariableReferences {
    const references: VariableReferences = {};
    const variables = new Map<string, Record<string, string>>();

    for (const value of Object.values(parseEnv(envText)))
        for (const [reference, rawId = "", key = ""] of (value ?? "").matchAll(
            VARIABLE_REFERENCE,
        )) {
            const id = referenceResourceId(rawId);

            if (!id)
                throw new ComposeVariableError(
                    `Invalid variable reference ${reference}. Pick the resource after typing {{ so it is saved as {{ <resourceId>.KEY }}.`,
                );

            if (id === resourceId)
                throw new ComposeVariableError(
                    `${reference} points at this resource itself. Use \${${key}} instead.`,
                );

            const target = targets.find((candidate) => candidate.id === id);

            if (!target)
                throw new ComposeVariableError(
                    `Variable reference ${reference} points to a resource that does not exist on this cluster.`,
                );

            if (!variables.has(id)) variables.set(id, referenceVariables(target, domain));
            const resolved = variables.get(id)?.[key];

            if (resolved === undefined)
                throw new ComposeVariableError(`Resource "${target.name}" has no variable ${key}.`);

            // ponytail: one level only; chained references would need cycle detection.
            if (resolved.search(VARIABLE_REFERENCE) !== -1)
                throw new ComposeVariableError(
                    `"${target.name}".${key} is itself a reference, which cannot be referenced.`,
                );

            references[`${id}.${key}`] = resolved;
        }

    return references;
}

/** Deploy-time check: broken `.env` references or references in Compose throw ComposeVariableError. */
export async function checkVariableReferences(
    db: Database,
    clusterId: string,
    resourceId: string,
    compose: string,
    envText: string,
) {
    assertNoComposeReference(compose);
    const ids = referencedResourceIds(envText);

    const targets = ids.length > 0 ? await referenceTargets(db, clusterId, ids) : [];

    // The worker fetches the real domain; any value satisfies `${STOAT_DOMAIN:?}` here.
    resolveReferences(envText, targets, "stoat-domain.invalid", resourceId);
}
