import { error, redirect } from "@sveltejs/kit";
import { getAuth } from "../../services";

/**
 * Form actions do not run layout loads, so each admin-only action checks the role itself.
 * Reads the live session: a cached one may still carry a revoked admin role.
 */
export async function requireInstanceAdmin(request: Request) {
    const session = await getAuth().api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true },
    });

    if (!session) redirect(303, "/login");

    if (session.user.role !== "admin") error(403, "Admins only.");

    return session;
}
