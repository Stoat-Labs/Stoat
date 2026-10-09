import type { resources } from "@stoat/db/schema/index";
import * as v from "valibot";

// Client-safe: the web app imports this to tell database resources apart.
export const databaseEngines = [
    "postgresql",
    "mongodb",
    "mariadb",
    "clickhouse",
    "redis",
    "dragonfly",
] as const;

export type DatabaseEngine = (typeof databaseEngines)[number];

/** Resource types deployed from a Compose spec; `database` resources are Compose resources too. */
export const composeResourceTypes = ["compose", "database"] as const;

const engineSettingsSchema = v.object({ engine: v.picklist(databaseEngines) });

/** The engine a `database` resource was created as, stored in `settings.engine`. */
export function databaseEngine(
    resource: Pick<typeof resources.$inferSelect, "type" | "settings">,
): DatabaseEngine | null {
    if (resource.type !== "database") return null;

    const parsed = v.safeParse(engineSettingsSchema, resource.settings);

    return parsed.success ? parsed.output.engine : null;
}
