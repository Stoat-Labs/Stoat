import { serviceVariable } from "@stoat/workflows/compose";

import { databaseServerEngine, type MetricsEngine } from "./observability";
import { composeServices } from "./project-graph";

// Same exporters and versions as the PostgreSQL and MariaDB templates.
const exporters: Record<MetricsEngine, string> = {
    postgres: `services:
    postgres-metrics:
        image: prometheuscommunity/postgres-exporter:v0.20.1
        restart: unless-stopped
        healthcheck:
            test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:9187/"]
            interval: 30s
            timeout: 5s
            retries: 3
`,
    mysql: `services:
    mysql-metrics:
        image: prom/mysqld-exporter:v0.21.0
        restart: unless-stopped
        command:
            - --mysqld.address=\${MYSQL_HOST}:3306
            - --mysqld.username=root
            - --collect.info_schema.schema_size
        healthcheck:
            test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:9104/"]
            interval: 30s
            timeout: 5s
            retries: 3
`,
};

/**
 * An exporter resource for the first database server in `compose`, wired to it through
 * `{{ <resourceId>.KEY }}` references to the keys the database resource exposes. A separate
 * resource, since a resource's only service gets its Variables as environment, which a second
 * service in the database's own Compose would take away.
 */
export function databaseExporter(compose: string, keys: string[], resourceId: string) {
    const server = composeServices(compose).flatMap(({ name, image }) => {
        const engine = image ? databaseServerEngine(image) : undefined;

        return engine ? [{ name, engine }] : [];
    })[0];

    if (!server) return { error: "This resource runs no PostgreSQL, MySQL or MariaDB server." };

    const reference = (key: string) => `{{ ${resourceId}.${key} }}`;
    const host = reference(`${serviceVariable(server.name)}_INTERNAL_HOST`);
    const exporterCompose = exporters[server.engine];

    if (server.engine === "postgres") {
        if (!keys.includes("POSTGRES_PASSWORD"))
            return { error: "The database has no POSTGRES_PASSWORD variable to connect with." };

        const user = keys.includes("POSTGRES_USER") ? reference("POSTGRES_USER") : "postgres";

        return {
            engine: server.engine,
            compose: exporterCompose,
            // `postgres` always exists; the exporter's collectors cover every database from it.
            env: [
                `DATA_SOURCE_URI=${host}:5432/postgres?sslmode=disable`,
                `DATA_SOURCE_USER=${user}`,
                `DATA_SOURCE_PASS=${reference("POSTGRES_PASSWORD")}`,
            ].join("\n"),
        };
    }

    const password = ["MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD"].find((key) =>
        keys.includes(key),
    );

    if (!password)
        return {
            error: "The database has no MARIADB_ROOT_PASSWORD or MYSQL_ROOT_PASSWORD variable.",
        };

    return {
        engine: server.engine,
        compose: exporterCompose,
        env: [`MYSQL_HOST=${host}`, `MYSQLD_EXPORTER_PASSWORD=${reference(password)}`].join("\n"),
    };
}
