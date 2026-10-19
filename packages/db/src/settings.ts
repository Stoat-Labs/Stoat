import { eq } from "drizzle-orm";
import type { Database } from ".";
import { instanceSettings, userSettings } from "./schema";

export async function getSignupsEnabled(db: Database) {
    const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));

    return settings?.signupsEnabled ?? false;
}

export async function setSignupsEnabled(db: Database, signupsEnabled: boolean) {
    await db.insert(instanceSettings).values({ id: 1, signupsEnabled }).onConflictDoUpdate({
        target: instanceSettings.id,
        set: { signupsEnabled },
    });
}

export async function getUserSettings(db: Database, userId: string) {
    const [settings] = await db
        .select({ canvasMode: userSettings.canvasMode })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));

    // Users have no row until they change something, so fall back to the column defaults.
    return settings ?? { canvasMode: true };
}

export async function setCanvasMode(db: Database, userId: string, canvasMode: boolean) {
    await db.insert(userSettings).values({ userId, canvasMode }).onConflictDoUpdate({
        target: userSettings.userId,
        set: { canvasMode },
    });
}
