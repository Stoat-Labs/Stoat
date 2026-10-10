import { redirect } from "@sveltejs/kit";
import { isOrganizationAdmin } from "@stoat/api";
import { listUserOrganizations } from "@stoat/db/organizations";
import { getAuth, getDb } from "../../services";

export const load = async ({ url, request, locals: { session } }) => {
    // Come back here after logging in. The login page sends a fresh install on to /setup.
    if (!session) redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    const organizations = await listUserOrganizations(getDb(), session.user.id);

    // Everything in the app is scoped to an organization; /setup creates the first one.
    if (organizations.length === 0) redirect(303, "/setup");
    let activeOrganizationId = session.session.activeOrganizationId;

    if (!organizations.some((organization) => organization.id === activeOrganizationId)) {
        activeOrganizationId = organizations[0]?.id ?? null;
        await getAuth().api.setActiveOrganization({
            headers: request.headers,
            body: { organizationId: activeOrganizationId },
        });
    }

    return {
        user: {
            name: session.user.name,
            email: session.user.email,
            image: session.user.image,
            role: session.user.role ?? null,
        },
        organizations,
        activeOrganizationId,
        // Pages hide actions the API would refuse; the API still enforces them.
        isOrganizationAdmin: isOrganizationAdmin(
            organizations.find((organization) => organization.id === activeOrganizationId)?.role ??
                "",
        ),
    };
};
