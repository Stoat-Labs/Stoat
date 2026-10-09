import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./index";
import { clusters, member, organization, s3Connections } from "./schema";

export function listUserOrganizations(db: Database, userId: string) {
    return db
        .select({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            role: member.role,
        })
        .from(member)
        .innerJoin(organization, eq(member.organizationId, organization.id))
        .where(eq(member.userId, userId))
        .orderBy(asc(member.createdAt), asc(member.id));
}

export async function getOrganizationMembership(
    db: Database,
    userId: string,
    organizationId: string,
) {
    const [membership] = await db
        .select()
        .from(member)
        .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
        .limit(1);

    return membership;
}

/**
 * Whether the organization still owns clusters or S3 connections. Deleting it would cascade
 * those rows away without stopping their jobs or revoking provider keys, so they must be
 * removed first through their own guarded flows.
 */
export async function organizationHasInfrastructure(db: Database, organizationId: string) {
    const [cluster] = await db
        .select({ id: clusters.id })
        .from(clusters)
        .where(eq(clusters.organizationId, organizationId))
        .limit(1);

    const [connection] = await db
        .select({ id: s3Connections.id })
        .from(s3Connections)
        .where(eq(s3Connections.organizationId, organizationId))
        .limit(1);

    return Boolean(cluster ?? connection);
}
