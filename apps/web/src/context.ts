import type { Context as ApiContext } from "@stoat/api/context";

import { getAuth, getDb } from "./services";

export type CreateContextOptions = {
    headers: Headers;
};

export async function createContext({ headers }: CreateContextOptions): Promise<ApiContext> {
    const db = await getDb();
    const key = headers.get("x-api-key");

    if (key) {
        const { valid, key: apiKey } = await getAuth().api.verifyApiKey({ body: { key } });

        return {
            db,
            session: null,
            apiKey: valid && apiKey ? { id: apiKey.id, organizationId: apiKey.referenceId } : null,
        };
    }

    const session = await getAuth().api.getSession({ headers });

    return {
        db,
        session,
    };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
