import { fail } from "@sveltejs/kit";
import { count } from "drizzle-orm";
import { organization, user } from "@stoat/db/schema/auth";
import { clusters, resources } from "@stoat/db/schema/index";
import { getSignupsEnabled, setSignupsEnabled } from "@stoat/db/settings";
import { requireInstanceAdmin } from "$lib/server/require-admin";
import { getDb } from "../../../services";

export const load = async ({ parent }) => {
    await parent();
    const db = getDb();

    const [[users], [organizations], [clusterCount], [resourceCount], signupsEnabled] =
        await Promise.all([
            db.select({ count: count() }).from(user),
            db.select({ count: count() }).from(organization),
            db.select({ count: count() }).from(clusters),
            db.select({ count: count() }).from(resources),
            getSignupsEnabled(db),
        ]);

    return {
        signupsEnabled,
        stats: [
            {
                title: "Users",
                count: users.count,
                description: "Registered users on the platform",
            },
            {
                title: "Organizations",
                count: organizations.count,
                description: "Active workspaces",
            },
            {
                title: "Clusters",
                count: clusterCount.count,
                description: "Connected Uncloud clusters",
            },
            { title: "Resources", count: resourceCount.count, description: "Managed resources" },
        ],
    };
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
