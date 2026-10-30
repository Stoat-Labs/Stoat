import type { RequestHandler } from "@sveltejs/kit";
import { receiveGitWebhook } from "@stoat/api/git/webhook";
import { getDb } from "../../../../services";

// The signature covers the raw bytes, so the body is read before any parsing.
export const POST: RequestHandler = async ({ params, request }) => {
    const body = Buffer.from(await request.arrayBuffer());

    const { status, message } = await receiveGitWebhook(
        getDb(),
        params.connectionId ?? "",
        request.headers,
        body,
    );

    return new Response(message, { status });
};
