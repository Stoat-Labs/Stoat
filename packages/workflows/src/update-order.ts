import YAML, { isMap } from "yaml";

/** Uncloud's `deploy.update_config.order`; null leaves the choice to Uncloud. */
export type UpdateOrder = "start-first" | "stop-first";

function openDocument(composeText: string, service: string) {
    const doc = YAML.parseDocument(composeText);

    if (doc.errors.length > 0) throw new Error("Invalid compose YAML");

    if (!isMap(doc.getIn(["services", service], true)))
        throw new Error(`Compose has no service "${service}"`);

    return { doc, path: ["services", service, "deploy", "update_config", "order"] };
}

/** The service's update order. Throws on invalid YAML or a missing service. */
export function serviceUpdateOrder(composeText: string, service: string): UpdateOrder | null {
    const { doc, path } = openDocument(composeText, service);
    const order = doc.getIn(path);

    return order === "start-first" || order === "stop-first" ? order : null;
}

/** Set or clear the update order, dropping `update_config` and `deploy` once empty. */
export function setServiceUpdateOrder(
    composeText: string,
    service: string,
    order: UpdateOrder | null,
): string {
    const { doc, path } = openDocument(composeText, service);

    if (order) {
        doc.setIn(path, order);

        return doc.toString();
    }

    doc.deleteIn(path);

    for (const parent of [path.slice(0, -1), path.slice(0, -2)]) {
        const node = doc.getIn(parent, true);

        if (isMap(node) && node.items.length === 0) doc.deleteIn(parent);
    }

    return doc.toString();
}
