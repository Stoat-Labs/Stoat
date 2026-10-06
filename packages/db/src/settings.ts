import { eq } from "drizzle-orm";
import type { Database } from ".";
import { instanceSettings } from "./schema";

export async function getSignupsEnabled(db: Database) {
    const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));

    return settings?.signupsEnabled ?? true;
}

export async function setSignupsEnabled(db: Database, signupsEnabled: boolean) {
    await db.insert(instanceSettings).values({ id: 1, signupsEnabled }).onConflictDoUpdate({
        target: instanceSettings.id,
        set: { signupsEnabled },
    });
}
