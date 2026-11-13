import { postgresService } from "../../packages/api/src/compose";
import { composeDatabaseService } from "@clowder/workflows/database-engines";
import { describe, expect, it } from "vite-plus/test";

const compose = (engine: string) =>
    `services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n    x-clowder:\n      engine: ${engine}\n`;

describe("x-clowder.engine", () => {
    it("names the service and engine, with postgres as PostgreSQL", () => {
        expect(composeDatabaseService(compose("postgres"))).toEqual({
            name: "db",
            engine: "postgresql",
        });
        expect(composeDatabaseService(compose("mariadb"))?.engine).toBe("mariadb");
        expect(composeDatabaseService("services:\n  web:\n    image: nginx\n")).toBeUndefined();
    });

    it("rejects an engine Clowder doesn't know", () => {
        expect(() => composeDatabaseService(compose("oracle"))).toThrow(
            `x-clowder.engine "oracle"`,
        );
    });

    it("points the Postgres tools at the marked service, not the first", () => {
        expect(postgresService(compose("postgres"))?.name).toBe("db");
    });
});
