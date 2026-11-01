// Image repository name (last path segment, without registry, tag, or digest) to icon.
// Add an entry here and drop the SVG in `static/icons` to support another image.
const ICONS = new Map([
    ["postgres", "/icons/postgresql.svg"],
    // PgDog publishes no SVG; this is the logo from its docs repository.
    ["pgdog", "/icons/pgdog.png"],
    ["rustfs", "/icons/rustfs.svg"],
]);

export function imageIcon(image: string | null | undefined) {
    const repository = image
        ?.split("@")[0]
        ?.replace(/:[^/]*$/u, "")
        .split("/")
        .at(-1)
        ?.toLowerCase();

    return repository ? (ICONS.get(repository) ?? null) : null;
}

// Database engine to icon, for a database whose image has none (e.g. TimescaleDB on Postgres).
const ENGINE_ICONS = new Map([["postgresql", "/icons/postgresql.svg"]]);

export function engineIcon(engine: string | null | undefined) {
    return engine ? (ENGINE_ICONS.get(engine) ?? null) : null;
}
