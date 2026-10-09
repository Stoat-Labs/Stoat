import { redirect } from "@sveltejs/kit";
import { getSignupsEnabled } from "@stoat/db/settings";
import { getDb } from "../../services";

export const load = async ({ locals }) => {
    if (locals.session) redirect(303, "/");

    return { signupsEnabled: await getSignupsEnabled(getDb()) };
};
