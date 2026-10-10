import { fail, redirect } from "@sveltejs/kit";
import { listUserOrganizations } from "@stoat/db/organizations";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";
import { isSetupRequired } from "@stoat/db/setup";
import { requireInstanceAdmin } from "$lib/server/require-admin";
import { getDb } from "../../services";

/**
 * The required step comes from the database: no accounts yet means creating the admin, and an
 * account without an organization creates one. The optional cluster steps that follow are the
 * instance admin's and live in the URL.
 */
export const load = async ({ locals: { session } }) => {
    const db = getDb();

    if (!session) {
        if (await isSetupRequired(db)) return { step: "account" as const, isAdmin: true };
        redirect(303, "/login?next=/setup");
    }

    const isAdmin = session.user.role === "admin";
    const organizations = await listUserOrganizations(db, session.user.id);

    if (organizations.length === 0) return { step: "organization" as const, isAdmin };

    if (!isAdmin) redirect(303, "/");

    return { step: "cluster" as const, isAdmin, signupsEnabled: await getSignupsEnabled(db) };
};

export const actions = {
    signups: async ({ request }) => {
        await requireInstanceAdmin(request);
        const value = (await request.formData()).get("signupsEnabled");

        if (value !== "true" && value !== "false")
            return fail(400, { error: "Invalid signup setting." });

        await setSignupsEnabled(getDb(), value === "true");

        return { saved: true };
    },
};
