import { orpc } from "$lib/api/orpc";

export type DatabaseInput = { clusterId: string; projectId: string; resourceId: string };

/** A read-only SQL query through the sidecar, cached like any other query. */
export function sqlQuery(input: DatabaseInput, query: string) {
    return orpc.resources.queryPostgres.queryOptions({
        input: { ...input, query },
        retry: false,
    });
}

/** Quotes an identifier for SQL, doubling any `"` inside it. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
