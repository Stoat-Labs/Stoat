import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
    user: {
        sessions: r.many.session(),
        accounts: r.many.account(),
        members: r.many.member(),
        invitations: r.many.invitation(),
    },
    session: {
        user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
        user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    organization: {
        members: r.many.member(),
        invitations: r.many.invitation(),
    },
    member: {
        organization: r.one.organization({
            from: r.member.organizationId,
            to: r.organization.id,
        }),
        user: r.one.user({ from: r.member.userId, to: r.user.id }),
    },
    invitation: {
        organization: r.one.organization({
            from: r.invitation.organizationId,
            to: r.organization.id,
        }),
        user: r.one.user({ from: r.invitation.inviterId, to: r.user.id }),
    },
}));
