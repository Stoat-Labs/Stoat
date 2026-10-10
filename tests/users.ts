import { randomUUID } from "node:crypto";
import type { Database } from "@stoat/db";

/**
 * Inserts a user who owns a new organization, as after /setup. Sign-up alone no longer
 * creates one. Returns the organization id.
 */
export async function insertUserWithOrganization(
    db: Database,
    userId: string,
    name: string,
    email: string,
) {
    const organizationId = randomUUID();

    await db.$client.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
        userId,
        name,
        email,
    ]);
    await db.$client.query(
        `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`,
        [organizationId, `${name}'s organization`, `org-${organizationId}`],
    );
    await db.$client.query(
        `INSERT INTO member (id, organization_id, user_id, role, created_at)
         VALUES ($1, $2, $3, 'owner', now())`,
        [randomUUID(), organizationId, userId],
    );

    return organizationId;
}
