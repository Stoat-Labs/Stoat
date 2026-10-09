import { error, redirect } from "@sveltejs/kit";

export const load = async ({ url, locals: { session } }) => {
    // Come back here after logging in.
    if (!session) redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);

    if (session.user.role !== "admin") error(403, "Admins only.");

    return {};
};
