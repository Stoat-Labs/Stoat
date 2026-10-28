import type { Database } from "@stoat/db";
import { parseEnv } from "node:util";
import {
    ComposeVariableError,
    assertNoComposeReference,
    composeServiceVariables,
    composeVariables,
    resourceComposePrefix,
    resourceEnv,
    type VariableReferences,
} from "./compose";
import { referenceResourceId, VARIABLE_REFERENCE } from "./variable-reference";

export type ReferenceTarget = {
    id: string;
    name: string;
    slug: string;
    projectId: string;
    projectName: string;
    // Raw jsonb; read through `resourceEnv` and `resourceComposePrefix`.
    settings: unknown;
    // Last deployed spec, so built-in hosts match what is running.
    spec: string;
    // Saved draft, for keys the deployed spec doesn't have yet, like a service moved in.
    draftSpec?: string;
};

/**
 * Compose resources a reference may point at: same cluster, never internal projects.
 * The cluster scope is the tenancy boundary, since env text can hold any UUID.
 */
export async function referenceTargets(db: Database, clusterId: string, ids?: string[]) {
    const { rows } = await db.$client.query<ReferenceTarget>(
        `SELECT r.id, r.name, r.slug, r.project_id AS "projectId", p.name AS "projectName", r.settings,
                coalesce(r.spec, r.draft_spec, '') AS spec,
                coalesce(r.draft_spec, r.spec, '') AS "draftSpec"
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

/** Where a referenceable key comes from, so pickers can group them like the Variables tab. */
export type ReferenceSource = "variables" | "compose" | "stoat";

function readVariables(target: ReferenceTarget, domain?: string) {
    const env = resourceEnv(target);
    const prefix = resourceComposePrefix(target);

    const identity = {
        projectId: target.projectId,
        projectName: target.projectName,
        resourceId: target.id,
        resourceName: target.name,
    };

    let variables: Record<string, string>;

    try {
        variables = composeVariables(target.spec, env, prefix, domain, undefined, identity);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Invalid variables.";

        throw new ComposeVariableError(`Unable to read variables from "${target.name}": ${reason}`);
    }

    let compose: Record<string, string> = {};

    try {
        compose = composeServiceVariables(target.spec, env, prefix, domain, identity);
    } catch {
        // A Compose file that cannot deploy only loses its own keys; Variables still resolve.
    }

    return { variables, compose };
}

/**
 * Variables a target exposes to references: built-ins, its own resolved `.env`, and what its
 * Compose `environment` sets. Variables win a shared key, though the container sees Compose's.
 */
export function referenceVariables(target: ReferenceTarget, domain?: string) {
    const { variables, compose } = readVariables(target, domain);

    return { ...compose, ...variables };
}

/** Keys a picker offers, by source. Draft keys count too, since references fall back to the draft. */
export function referenceKeys(target: ReferenceTarget) {
    const own = parseEnv(resourceEnv(target));
    const keys = new Map<string, ReferenceSource>();

    for (const spec of new Set([target.spec, target.draftSpec ?? target.spec])) {
        let read: ReturnType<typeof readVariables>;

        try {
            // Keys only, so any domain satisfies `${STOAT_DOMAIN:?}`.
            read = readVariables({ ...target, spec }, "stoat-domain.invalid");
        } catch {
            continue;
        }

        for (const key of Object.keys({ ...read.compose, ...read.variables }))
            keys.set(key, key in own ? "variables" : key in read.variables ? "stoat" : "compose");
    }

    // Unreadable Compose still leaves the target's own Variables to offer.
    if (keys.size === 0) for (const key of Object.keys(own)) keys.set(key, "variables");

    return Array.from(keys, ([key, source]) => ({ key, source })).toSorted((a, b) =>
        a.key < b.key ? -1 : 1,
    );
}

function draftVariable(target: ReferenceTarget, key: string, domain?: string) {
    if (!target.draftSpec || target.draftSpec === target.spec) return undefined;

    try {
        return referenceVariables({ ...target, spec: target.draftSpec }, domain)[key];
    } catch {
        // A broken draft only loses the fallback; the deployed spec already answered.
        return undefined;
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

            // A service moved into the target resolves before the target deploys it, so the
            // resource it left can deploy first. Keys that exist when deployed never change.
            const resolved = variables.get(id)?.[key] ?? draftVariable(target, key, domain);

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
