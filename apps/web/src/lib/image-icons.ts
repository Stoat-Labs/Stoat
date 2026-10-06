// Image repository name (last path segment, without registry, tag, or digest) to icon.
// Add an entry here and drop the SVG in `static/icons` to support another image.
const ICONS = new Map([["postgres", "/icons/postgresql.svg"]]);

export function imageIcon(image: string | null | undefined) {
    const repository = image
        ?.split("@")[0]
        ?.replace(/:[^/]*$/u, "")
        .split("/")
        .at(-1)
        ?.toLowerCase();

    return repository ? (ICONS.get(repository) ?? null) : null;
}
