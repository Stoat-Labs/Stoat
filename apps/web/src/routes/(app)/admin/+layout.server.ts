import { error, redirect } from "@sveltejs/kit";
import { getAuth } from "../../../services";

export const load = async ({ request }) => {
    const session = await getAuth().api.getSession({ headers: request.headers });

    if (!session) redirect(303, "/login");

    if (session.user.role !== "admin") error(403, "Admins only.");

    return {};
};
