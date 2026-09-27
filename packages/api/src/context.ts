import type { createAuth } from "@stoat/auth";
import type { Database } from "@stoat/db";

export type Context = {
    session: Awaited<ReturnType<ReturnType<typeof createAuth>["api"]["getSession"]>>;
    /** Set when the request authenticated with an organization API key instead of a session. */
    apiKey?: { id: string; organizationId: string } | null;
    db: Database;
};
