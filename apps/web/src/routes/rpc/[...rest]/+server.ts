import { BatchResponseCompressionHandlerPlugin } from "@orpc/node";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { onError, ORPCError, ValidationError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin } from "@orpc/server/plugins";
import { appRouter } from "@stoat/api/routers/index";
import { getRequestEvent } from "$app/server";
import type { RequestHandler } from "@sveltejs/kit";

import { createContext } from "../../../context";

// Caller mistakes rather than server faults, so they are logged as warnings.
const clientErrors = new Set([
    "BAD_REQUEST",
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "PRECONDITION_FAILED",
    "UNPROCESSABLE_CONTENT",
    "TOO_MANY_REQUESTS",
]);

/** Puts the reason for a failed call on the request's wide event, not just its status code. */
function logError(error: Error) {
    const { log } = getRequestEvent().locals;

    if (!(error instanceof ORPCError) || !clientErrors.has(error.code)) {
        log.error(error);

        return;
    }

    log.warn(error.message, {
        rpcError: {
            code: error.code,
            issues:
                error.cause instanceof ValidationError
                    ? error.cause.issues.map((issue) => ({
                          path: issue.path?.map(String).join("."),
                          message: issue.message,
                      }))
                    : undefined,
        },
    });
}

const rpcHandler = new RPCHandler(appRouter, {
    plugins: [new BatchHandlerPlugin(), new BatchResponseCompressionHandlerPlugin()],
    interceptors: [
        onError((error) => logError(error instanceof Error ? error : new Error(String(error)))),
    ],
});

const apiHandler = new OpenAPIHandler(appRouter, {
    interceptors: [
        onError((error) => logError(error instanceof Error ? error : new Error(String(error)))),
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
