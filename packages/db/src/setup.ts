import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from ".";
import { invitation, user } from "./schema/auth";

/** A fresh install has no accounts yet; its first sign-up becomes the instance admin. */
export async function isSetupRequired(db: Database) {
    const [anyUser] = await db.select({ id: user.id }).from(user).limit(1);

    return anyUser === undefined;
}

/** Lets invited people create an account while public sign-ups are closed. */
export async function hasPendingInvitation(db: Database, email: string) {
    const [pending] = await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
            and(
                eq(sql`lower(${invitation.email})`, email.trim().toLowerCase()),
                eq(invitation.status, "pending"),
                gt(invitation.expiresAt, new Date()),
            ),
        )
        .limit(1);

    return pending !== undefined;
}

export async function isInvitationPending(db: Database, invitationId: string) {
    const [pending] = await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(
            and(
                eq(invitation.id, invitationId),
                eq(invitation.status, "pending"),
                gt(invitation.expiresAt, new Date()),
            ),
        )
        .limit(1);

    return pending !== undefined;
}
