import type { resources } from "@stoat/db/schema/index";
import { databaseEngines, type DatabaseEngine } from "@stoat/workflows/database-engines";
import * as v from "valibot";

export { databaseEngines, type DatabaseEngine };

/** Resource types deployed from a Compose spec; `database` resources are Compose resources too. */
export const composeResourceTypes = ["compose", "database"] as const;

const engineSettingsSchema = v.object({ engine: v.picklist(databaseEngines) });

/** The engine a `database` resource was created as, or a deployed `x-stoat.engine` set, in `settings.engine`. */
export function databaseEngine(
    resource: Pick<typeof resources.$inferSelect, "type" | "settings">,
): DatabaseEngine | null {
    if (resource.type !== "database") return null;

    const parsed = v.safeParse(engineSettingsSchema, resource.settings);

    return parsed.success ? parsed.output.engine : null;
}
