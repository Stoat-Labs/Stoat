import { and, eq, inArray, notExists } from "drizzle-orm";
import type { Database } from "./index";
import { resourceGroups, resources } from "./schema/index";

/** A group nothing is in any more has no frame to show, so it goes. */
export async function deleteEmptyGroups(
    db: Pick<Database, "delete" | "select">,
    projectIds: string[],
) {
    if (!projectIds.length) return;

    await db
        .delete(resourceGroups)
        .where(
            and(
                inArray(resourceGroups.projectId, projectIds),
                notExists(
                    db
                        .select({ id: resources.id })
                        .from(resources)
                        .where(eq(resources.groupId, resourceGroups.id)),
                ),
            ),
        );
}
