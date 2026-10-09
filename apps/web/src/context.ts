import type { Context as ApiContext } from "@stoat/api/context";
import type { RequestEvent } from "@sveltejs/kit";

import { getAuth, getDb } from "./services";

export async function createContext(event: RequestEvent): Promise<ApiContext> {
    const db = getDb();
    const key = event.request.headers.get("x-api-key");

    if (key) {
        const { valid, key: apiKey } = await getAuth().api.verifyApiKey({ body: { key } });

        return {
            db,
            session: null,
            apiKey: valid && apiKey ? { id: apiKey.id, organizationId: apiKey.referenceId } : null,
        };
    }

    return {
        db,
        session: event.locals.session,
    };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
