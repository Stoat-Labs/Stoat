import YAML from "yaml";

// `[registry[:port]/]path[:tag][@digest]`, loose enough for every registry Railway lists.
const IMAGE_REFERENCE =
    /^(?:[a-z0-9][\w.-]*:\d+\/)?[a-z0-9][\w.\-/]*(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/u;

export function isImageReference(image: string) {
    return IMAGE_REFERENCE.test(image);
}

/** The image's last path segment as a Compose service name: `ghcr.io/org/my_app:1` is `my_app`. */
export function imageServiceName(image: string) {
    const repository =
        image
            .split("@")[0]
            ?.replace(/:[^/]*$/u, "")
            .split("/")
            .at(-1) ?? "";

    const name = repository
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, "-")
        .replace(/^[^a-z0-9]+/u, "");

    return name || "app";
}

/** A one-service Compose draft running `image`. */
export function imageCompose(image: string) {
    return YAML.stringify({ services: { [imageServiceName(image)]: { image } } });
}
