import { ORPCError, ValidationError } from "@orpc/server";
import type { RequestLogger } from "evlog";

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

/** Puts the reason for a failed call on its wide event, not just its status code. */
export function logRpcError(log: RequestLogger, error: Error) {
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
