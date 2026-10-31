import YAML from "yaml";

// Client-safe: the web app imports this to tell database resources apart.
export const databaseEngines = [
    "postgresql",
    "mongodb",
    "mariadb",
    "clickhouse",
    "redis",
    "dragonfly",
] as const;

export type DatabaseEngine = (typeof databaseEngines)[number];

const aliases = new Map<string, DatabaseEngine>([["postgres", "postgresql"]]);

/** The engine of a service's `x-stoat.engine` value, if it names one. */
export function parseDatabaseEngine(value: string): DatabaseEngine | undefined {
    return aliases.get(value) ?? databaseEngines.find((engine) => engine === value);
}

/**
 * The service whose `x-stoat.engine` forces the resource to be a database, e.g.
 * `services.db.x-stoat.engine: postgres`. Throws on an engine Stoat doesn't know.
 */
export function composeDatabaseService(compose: string) {
    const services = YAML.parseDocument(compose).get("services");

    if (!YAML.isMap(services)) return;

    for (const { key, value } of services.items) {
        if (!YAML.isMap(value)) continue;
        const raw = value.getIn(["x-stoat", "engine"]);

        if (raw === undefined) continue;
        const engine = parseDatabaseEngine(String(raw));

        if (!engine)
            throw new Error(
                `x-stoat.engine "${String(raw)}" isn't one of: postgres, ${databaseEngines.join(", ")}.`,
            );

        return { name: String(YAML.isScalar(key) ? key.value : key), engine };
    }
}
