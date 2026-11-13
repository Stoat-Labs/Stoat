import type { createAuth } from "@clowder/auth";
import type { Database } from "@clowder/db";

export type Context = {
    session: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>;
    /** Set when the request authenticated with an organization API key instead of a session. */
    apiKey?: { id: string; organizationId: string } | null;
    db: Database;
};
