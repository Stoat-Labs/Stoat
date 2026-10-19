import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { appRouter } from "@stoat/api/routers/index";
import { getRequestEvent } from "$app/server";
import type { RequestHandler } from "@sveltejs/kit";

import { createContext } from "../../../context";
import { logRpcError } from "$lib/server/rpc-errors";

// The browser talks RPC over the /rpc WebSocket ($lib/server/rpc-socket.ts). This route only
// serves the REST API, since API key clients send an x-api-key header a WebSocket cannot carry.
const apiHandler = new OpenAPIHandler(appRouter, {
    interceptors: [
        onError((error) =>
            logRpcError(
                getRequestEvent().locals.log,
                error instanceof Error ? error : new Error(String(error)),
            ),
        ),
    ],
});

const handle: RequestHandler = async (event) => {
    const context = await createContext(event);

    const { response } = await apiHandler.handle(event.request, {
        prefix: "/rpc/api",
        context,
    });

    return response ?? new Response("Not found", { status: 404 });
};

export const HEAD = handle;

export const GET = handle;

export const POST = handle;

export const PUT = handle;

export const PATCH = handle;

export const DELETE = handle;
