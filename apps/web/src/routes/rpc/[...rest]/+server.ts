import { BatchResponseCompressionHandlerPlugin } from "@orpc/node";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin } from "@orpc/server/plugins";
import { appRouter } from "@stoat/api/routers/index";
import type { RequestHandler } from "@sveltejs/kit";

import { createContext } from "../../../context";

const rpcHandler = new RPCHandler(appRouter, {
    plugins: [new BatchHandlerPlugin(), new BatchResponseCompressionHandlerPlugin()],
    interceptors: [
        onError((error) => {
            console.error(error);
        }),
    ],
});

const apiHandler = new OpenAPIHandler(appRouter, {
    interceptors: [
        onError((error) => {
            console.error(error);
        }),
    ],
});

const handle: RequestHandler = async ({ request }) => {
    const context = await createContext({
        headers: request.headers,
    });

    const rpcResult = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context,
    });

    if (rpcResult.response) return rpcResult.response;

    const apiResult = await apiHandler.handle(request, {
        prefix: "/rpc/api",
        context,
    });

    if (apiResult.response) return apiResult.response;

    return new Response("Not found", { status: 404 });
};

export const HEAD = handle;

export const GET = handle;

export const POST = handle;

export const PUT = handle;

export const PATCH = handle;

export const DELETE = handle;
