import { error, fail, redirect } from "@sveltejs/kit";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";
import { getAuth, getDb } from "../../../../services";

export const load = async ({ parent }) => {
    await parent();

    return { signupsEnabled: await getSignupsEnabled(getDb()) };
};

export const actions = {
    default: async ({ request }) => {
        // Actions do not run layout loads: enforce the admin boundary here too.
        // Read the live session: a cached one may still carry a revoked admin role.
        const session = await getAuth().api.getSession({
            headers: request.headers,
            query: { disableCookieCache: true },
        });

        if (!session) redirect(303, "/login");

        if (session.user.role !== "admin") error(403, "Admins only.");
        const value = (await request.formData()).get("signupsEnabled");

        if (value !== "true" && value !== "false")
            return fail(400, { error: "Invalid signup setting." });

        try {
            await setSignupsEnabled(getDb(), value === "true");
        } catch {
            return fail(500, { error: "Unable to save settings. Try again." });
        }

        return { saved: true };
    },
};
