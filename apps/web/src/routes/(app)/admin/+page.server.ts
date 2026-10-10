import { count } from "drizzle-orm";
import { organization, user } from "@stoat/db/schema/auth";
import { clusters, resources } from "@stoat/db/schema/index";
import { getDb } from "../../../services";

export const load = async ({ parent }) => {
    await parent();
    const db = getDb();

    const [[users], [organizations], [clusterCount], [resourceCount]] = await Promise.all([
        db.select({ count: count() }).from(user),
        db.select({ count: count() }).from(organization),
        db.select({ count: count() }).from(clusters),
        db.select({ count: count() }).from(resources),
    ]);

    return {
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
