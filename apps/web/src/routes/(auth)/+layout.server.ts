import { redirect } from "@sveltejs/kit";
import { getSignupsEnabled } from "@stoat/db/settings";
import { getAuth, getDb } from "../../services";

export const load = async ({ request }) => {
    if (await getAuth().api.getSession({ headers: request.headers })) redirect(303, "/");

    return { signupsEnabled: await getSignupsEnabled(getDb()) };
};
