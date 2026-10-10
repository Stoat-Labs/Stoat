import { fail } from "@sveltejs/kit";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";
import { requireInstanceAdmin } from "$lib/server/require-admin";
import { getDb } from "../../../../services";

export const load = async ({ parent }) => {
    await parent();

    return { signupsEnabled: await getSignupsEnabled(getDb()) };
};

export const actions = {
    default: async ({ request }) => {
        await requireInstanceAdmin(request);
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
