import { composeVariables, interpolateCompose } from "@stoat/workflows/compose";
import {
    referenceKeys,
    resolveReferences,
    type ReferenceTarget,
} from "@stoat/workflows/references";
import { expect, it } from "vite-plus/test";
import { databaseExporter } from "../../packages/api/src/database-metrics";

const target = (id: string, spec: string, env: string): ReferenceTarget => ({
    id,
    name: "db",
    slug: "db-abc123",
    projectId: "00000000-0000-4000-8000-000000000000",
    projectName: "project",
    settings: { env },
    spec,
});

const keys = (resource: ReferenceTarget) => referenceKeys(resource).map(({ key }) => key);

it("wires a postgres-exporter to a TimescaleDB resource whose password lives in Variables", () => {
    const id = "fda4c032-77a6-4721-8c8d-511446f55fb5";

    const db = target(
        id,
        "services:\n    uk-db:\n        image: timescale/timescaledb:2.31.0-pg18\n",
        "POSTGRES_PASSWORD=secret",
    );

    const exporter = databaseExporter(db.spec, keys(db), id);

    if ("error" in exporter) throw new Error(exporter.error);
    expect(exporter.engine).toBe("postgres");

    const references = resolveReferences(exporter.env, [db]);
    const env = composeVariables(exporter.compose, exporter.env, "", undefined, references);

    expect(env.DATA_SOURCE_URI).toBe("db-abc123-uk-db.internal:5432/postgres?sslmode=disable");
    expect(env.DATA_SOURCE_USER).toBe("postgres");
    expect(env.DATA_SOURCE_PASS).toBe("secret");
});

it("wires a mysqld-exporter to MariaDB whose root password is set in Compose", () => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

    const db = target(
        id,
        "services:\n    db:\n        image: mariadb:10.11\n        environment:\n            MYSQL_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD}\n",
        "MARIADB_ROOT_PASSWORD=secret",
    );

    const exporter = databaseExporter(db.spec, keys(db), id);

    if ("error" in exporter) throw new Error(exporter.error);
    expect(exporter.engine).toBe("mysql");

    const references = resolveReferences(exporter.env, [db]);
    const env = composeVariables(exporter.compose, exporter.env, "", undefined, references);

    expect(env.MYSQL_HOST).toBe("db-abc123-db.internal");
    expect(env.MYSQLD_EXPORTER_PASSWORD).toBe("secret");
    expect(exporter.compose).toContain("--mysqld.address=${MYSQL_HOST}:3306");
});

it("refuses resources without a supported server or a password to connect with", () => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

    expect(
        databaseExporter("services:\n    cache:\n        image: redis:8\n", [], id),
    ).toHaveProperty("error");
    expect(
        databaseExporter("services:\n    db:\n        image: mysql:9\n", ["MYSQL_HOST"], id),
    ).toHaveProperty("error");
});

it("recognizes a server whose image is a Compose variable", () => {
    const id = "cdb9a855-4607-4d07-9375-33547738c8c2";

    const db = target(
        id,
        "services:\n    seafile-db:\n        image: ${SEAFILE_DB_IMAGE:-mariadb:13.0}\n        environment:\n            - MYSQL_ROOT_PASSWORD=${INIT_SEAFILE_MYSQL_ROOT_PASSWORD:-}\n",
        "INIT_SEAFILE_MYSQL_ROOT_PASSWORD=secret",
    );

    const exporter = databaseExporter(
        interpolateCompose(db.spec, "INIT_SEAFILE_MYSQL_ROOT_PASSWORD=secret"),
        keys(db),
        id,
    );

    if ("error" in exporter) throw new Error(exporter.error);
    expect(exporter.env).toContain(`{{ ${id}.SEAFILE_DB_INTERNAL_HOST }}`);
    expect(resolveReferences(exporter.env, [db])[`${id}.MYSQL_ROOT_PASSWORD`]).toBe("secret");
});
