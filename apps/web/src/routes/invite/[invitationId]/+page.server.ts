import { redirect } from "@sveltejs/kit";
import { getAuth } from "../../../services";

export const load = async ({ request, params }) => {
    if (!(await getAuth().api.getSession({ headers: request.headers })))
        redirect(303, `/login?next=${encodeURIComponent(`/invite/${params.invitationId}`)}`);

    return { invitationId: params.invitationId };
};
