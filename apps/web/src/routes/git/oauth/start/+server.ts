import type { RequestHandler } from "@sveltejs/kit";
import {
    assertGitOAuthOrigin,
    createGitOAuthFlow,
    getGitOAuthConnection,
    getGitOAuthCookieConfig,
    getOrganizationGitOAuthProviders,
    GitOAuthError,
    requireGitOAuthAdmin,
} from "@stoat/api/git-oauth";
import { getAuth, getDb } from "../../../../services";

export const POST: RequestHandler = async ({ request, cookies }) => {
    try {
        assertGitOAuthOrigin(request);
        const db = getDb();

        const session = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });

        const identity = await requireGitOAuthAdmin(db, session);

        if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))
            throw new GitOAuthError("invalid_request");

        // SvelteKit's BODY_SIZE_LIMIT already bounds the body.
        const form = new URLSearchParams(await request.text());
        const fields = ["organizationId", "providerId", "name", "connectionId"];

        if ([...form.keys()].some((key) => !fields.includes(key) || form.getAll(key).length !== 1))
            throw new GitOAuthError("invalid_request");

        if (!form.get("organizationId")) throw new GitOAuthError("invalid_request");

        if (form.get("organizationId") !== identity.organizationId)
            throw new GitOAuthError("forbidden");
        const providers = await getOrganizationGitOAuthProviders(db, identity.organizationId);
        const provider = providers.find((entry) => entry.id === form.get("providerId"));

        if (!provider) throw new GitOAuthError("configuration");
        const connectionId = form.get("connectionId") || undefined;
        let name = form.get("name")?.trim() ?? "";

        if (connectionId) {
            const connection = await getGitOAuthConnection(
                db,
                identity.organizationId,
                connectionId,
                provider,
            );

            name ||= connection.name;
        }

        const flow = createGitOAuthFlow(
            {
                ...identity,
                providerId: provider.id,
                name,
                connectionId,
            },
            providers,
        );

        const cookieConfig = getGitOAuthCookieConfig();
        cookies.set(cookieConfig.name, flow.cookie, cookieConfig.options);

        return new Response(null, {
            status: 303,
            headers: {
                location: flow.authorizationUrl,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
            },
        });
    } catch (error) {
        const code = error instanceof GitOAuthError ? error.code : "failed";

        return new Response(null, {
            status: 303,
            headers: {
                location: `/git?oauth=${code}`,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
            },
        });
    }
};
