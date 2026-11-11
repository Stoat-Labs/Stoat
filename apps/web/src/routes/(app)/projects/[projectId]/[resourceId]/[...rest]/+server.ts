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

// Saved log links carried their range; the canvas Logs tab reads the same names.
const keptParams = ["logStart", "logEnd"];

// Old resource pages (/projects/:project/:resource/<tab>[/<deployment>]) open that resource's canvas panel.
export const GET = ({ params, url }) => {
    const [segment = "", deploymentId] = params.rest.split("/");
    const tab = tabs.get(segment);
    const query = new URLSearchParams({ node: params.resourceId });

    if (tab) query.set("tab", tab);

    if (segment === "deployments" && deploymentId) query.set("deployment", deploymentId);

    for (const name of keptParams) {
        const value = url.searchParams.get(name);

        if (value) query.set(name, value);
    }

    redirect(308, `/projects/${params.projectId}/canvas?${query}`);
};
