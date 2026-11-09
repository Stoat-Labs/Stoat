import { redirect } from "@sveltejs/kit";

// Each old resource page and the canvas panel tab that replaced it; Networking under Settings lists ingress.
const tabs = new Map([
    ["deployments", "deployments"],
    ["variables", "variables"],
    ["metrics", "metrics"],
    ["logs", "logs"],
    ["settings", "settings"],
    ["ingress", "settings"],
]);

// Old resource pages (/projects/:project/:resource/<tab>) open that resource's canvas panel.
export const GET = ({ params }) => {
    const tab = tabs.get(params.rest.split("/")[0] ?? "");
    const query = new URLSearchParams({ node: params.resourceId });

    if (tab) query.set("tab", tab);

    redirect(308, `/projects/${params.projectId}/canvas?${query}`);
};
