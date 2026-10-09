import { redirect } from "@sveltejs/kit";

export const load = async ({ locals, params }) => {
    if (!locals.session)
        redirect(303, `/login?next=${encodeURIComponent(`/invite/${params.invitationId}`)}`);

    return { invitationId: params.invitationId };
};
