import { redirect } from "@sveltejs/kit";
import { getSignupsEnabled } from "@stoat/db/settings";
import { isInvitationPending, isSetupRequired } from "@stoat/db/setup";
import { getDb } from "../../services";

export const load = async ({ locals, url }) => {
    if (locals.session) redirect(303, "/");
    const db = getDb();

    // A fresh install has nobody to log in as yet.
    if (await isSetupRequired(db)) redirect(303, "/setup");

    return { signupsEnabled: await canShowSignup(url) };
};

/** Invitees may sign up while public sign-ups are closed; the auth server checks their email. */
async function canShowSignup(url: URL) {
    if (await getSignupsEnabled(getDb())) return true;
    const invitationId = /^\/invite\/([^/?#]+)$/u.exec(url.searchParams.get("next") ?? "")?.[1];

    return invitationId !== undefined && (await isInvitationPending(getDb(), invitationId));
}
