import YAML, { isMap, isScalar } from "yaml";

/** Uncloud's `deploy.update_config.order`; null leaves the choice to Uncloud. */
export type UpdateOrder = "start-first" | "stop-first";

/** A resource has one service, so this reads and writes the first one. */
function openDocument(composeText: string) {
    const doc = YAML.parseDocument(composeText);

    if (doc.errors.length > 0) throw new Error("Invalid compose YAML");

    const services = doc.get("services", true);
    const key = isMap(services) ? services.items[0]?.key : undefined;

    if (!isScalar(key)) throw new Error("Compose has no service");

    return { doc, path: ["services", String(key.value), "deploy", "update_config", "order"] };
}

/** The service's update order. Throws on invalid YAML or no service. */
export function serviceUpdateOrder(composeText: string): UpdateOrder | null {
    const { doc, path } = openDocument(composeText);
    const order = doc.getIn(path);

    return order === "start-first" || order === "stop-first" ? order : null;
}

/** Set or clear the update order, dropping `update_config` and `deploy` once empty. */
export function setServiceUpdateOrder(composeText: string, order: UpdateOrder | null): string {
    const { doc, path } = openDocument(composeText);

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
