import YAML, { isAlias, isMap, isScalar, isSeq } from "yaml";
import type { Document, Node, YAMLMap, YAMLSeq } from "yaml";

/** Named volumes only; bind mounts (`./data`, `/srv`) and anonymous volumes are not volumes here. */
export const NAMED_VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

export class ComposeVolumeError extends Error {}

function parse(compose: string) {
    const doc = YAML.parseDocument(compose);

    if (doc.errors.length) throw new ComposeVolumeError("Fix the Compose YAML errors first.");

    return doc;
}

function serviceNode(doc: Document, name: string) {
    const services = doc.get("services", true);
    const service = isMap(services) ? services.get(name, true) : undefined;

    if (!isMap(service)) throw new ComposeVolumeError(`Service "${name}" was not found.`);

    return service;
}

function declared(doc: Document) {
    const volumes = doc.get("volumes", true);

    return isMap(volumes) ? volumes : undefined;
}

/** The named volume a service mount uses, in either Compose syntax. */
function mountSource(item: Node | null) {
    if (isScalar(item)) {
        const [source = ""] = String(item.value).split(":");

        return String(item.value).includes(":") && NAMED_VOLUME.test(source) ? source : undefined;
    }

    if (!isMap(item)) return undefined;

    const source = item.get("source", true);
    const type = item.get("type", true);

    return isScalar(source) && (!isScalar(type) || type.value === "volume")
        ? String(source.value)
        : undefined;
}

/** Where a service mount puts the volume inside the container. */
function mountTarget(item: Node | null) {
    if (isScalar(item)) return String(item.value).split(":")[1] ?? "";

    const target = isMap(item) ? item.get("target", true) : undefined;

    return isScalar(target) ? String(target.value) : "";
}

function mounts(doc: Document, service: YAMLMap) {
    let volumes: unknown = service.get("volumes", true);

    // `volumes: *shared` is one list for every service using the anchor, so edit this service's copy.
    if (isAlias(volumes)) {
        const shared = volumes.resolve(doc);

        if (!isSeq(shared)) return undefined;

        volumes = doc.createNode(shared.toJSON());
        service.set("volumes", volumes);
    }

    // SAFETY: Compose mounts are scalars (short syntax) or maps (long syntax); mountSource checks which.
    return isSeq(volumes) ? (volumes as YAMLSeq<Node | null>) : undefined;
}

function mount(doc: Document, volume: string, service: string, target: string) {
    if (!NAMED_VOLUME.test(volume))
        throw new ComposeVolumeError(
            "Volume names use letters, digits, dots, hyphens and underscores.",
        );

    if (!target.startsWith("/") || /[\s:]/u.test(target))
        throw new ComposeVolumeError("The mount path must be absolute, like /data.");

    const node = serviceNode(doc, service);
    const existing = mounts(doc, node);

    if (existing?.items.some((item) => mountSource(item) === volume))
        throw new ComposeVolumeError(`"${service}" already mounts "${volume}".`);

    const entry = `${volume}:${target}`;

    if (existing) existing.add(doc.createNode(entry));
    else node.set("volumes", doc.createNode([entry]));
}

/** Declares a new volume and mounts it into a service. */
export function addVolume(compose: string, volume: string, service: string, target: string) {
    const doc = parse(compose);

    if (declared(doc)?.has(volume))
        throw new ComposeVolumeError(`A volume named "${volume}" already exists.`);

    mount(doc, volume, service, target);

    if (!declared(doc)) doc.set("volumes", doc.createNode({}));

    declared(doc)?.set(volume, doc.createNode({}));

    return String(doc);
}

/** Mounts a volume the Compose file already declares into another service. */
export function attachVolume(compose: string, volume: string, service: string, target: string) {
    const doc = parse(compose);

    if (!declared(doc)?.has(volume))
        throw new ComposeVolumeError(`There is no volume named "${volume}".`);

    mount(doc, volume, service, target);

    return String(doc);
}

/** Unmounts a volume from one service; the volume stays declared, so its data stays reachable. */
export function detachVolume(compose: string, volume: string, service: string) {
    const doc = parse(compose);
    const node = serviceNode(doc, service);
    const existing = mounts(doc, node);

    if (!existing?.items.some((item) => mountSource(item) === volume))
        throw new ComposeVolumeError(`"${service}" does not mount "${volume}".`);

    // Every path the service mounts it at, so it no longer uses the volume.
    existing.items = existing.items.filter((item) => mountSource(item) !== volume);

    if (existing.items.length === 0) node.delete("volumes");

    return String(doc);
}

/** Every named-volume mount of every service, in file order. */
export function volumeMounts(compose: string) {
    const doc = parse(compose);
    const services = doc.get("services", true);

    if (!isMap(services)) return [];

    return services.items.flatMap(({ key, value }) =>
        isMap(value)
            ? (mounts(doc, value)?.items ?? []).flatMap((item) => {
                  const volume = mountSource(item);

                  return volume
                      ? [
                            {
                                volume,
                                service: String(isScalar(key) ? key.value : ""),
                                target: mountTarget(item),
                            },
                        ]
                      : [];
              })
            : [],
    );
}

/** The Docker name a volume is pinned to by `name:`, if its declaration sets one. */
export function pinnedVolumeName(compose: string, volume: string) {
    const name = declared(parse(compose))?.getIn([volume, "name"], true);

    return isScalar(name) ? String(name.value) : undefined;
}

/** `<service>-volume`, numbered when the name is taken, like Railway's `redis-volume`. */
export function nextVolumeName(compose: string, service: string) {
    const taken = new Set(volumeMounts(compose).map((entry) => entry.volume));
    const names = declared(parse(compose));
    const base = `${service}-volume`.replaceAll(/[^a-zA-Z0-9_.-]/gu, "-");

    for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base}-${n}`;

        if (!taken.has(name) && !names?.has(name)) return name;
    }
}

/**
 * Points an existing mount at another path, keeping its other options. `from` picks one of several
 * paths the service mounts the volume at; without it the first one moves.
 */
export function remountVolume(
    compose: string,
    volume: string,
    service: string,
    target: string,
    from?: string,
) {
    if (!target.startsWith("/") || /[\s:]/u.test(target))
        throw new ComposeVolumeError("The mount path must be absolute, like /data.");

    const doc = parse(compose);
    const existing = mounts(doc, serviceNode(doc, service));

    const index =
        existing?.items.findIndex(
            (item) =>
                mountSource(item) === volume && (from === undefined || mountTarget(item) === from),
        ) ?? -1;

    const item = existing?.items[index];

    if (!existing || !item)
        throw new ComposeVolumeError(`"${service}" does not mount "${volume}".`);

    if (isMap(item)) item.set("target", target);
    else {
        const [source = "", , ...options] = String(isScalar(item) ? item.value : "").split(":");

        existing.items[index] = doc.createNode([source, target, ...options].join(":"));
    }

    return String(doc);
}

/** Deletes a volume from the Compose file, unmounting it from every service first. */
export function removeVolume(compose: string, volume: string) {
    const doc = parse(compose);
    const volumes = declared(doc);

    if (!volumes?.has(volume))
        throw new ComposeVolumeError(`There is no volume named "${volume}".`);

    const services = doc.get("services", true);

    for (const { value } of isMap(services) ? services.items : []) {
        const existing = isMap(value) ? mounts(doc, value) : undefined;

        if (!isMap(value) || !existing) continue;

        existing.items = existing.items.filter((item) => mountSource(item) !== volume);

        if (existing.items.length === 0) value.delete("volumes");
    }

    volumes.delete(volume);

    // A section the removal emptied would linger as `volumes: {}`.
    if (volumes.items.length === 0) doc.delete("volumes");

    return String(doc);
}
