import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";
import {
    composePublishedPorts,
    enablePostgresPort,
    postgresService,
    publishedPortNumbers,
} from "../../packages/api/src/compose";

const compose =
    '# Keep this comment\nservices:\n  db:\n    image: "postgres:18"\n    volumes: [data:/var/lib/postgresql]\nvolumes:\n  data: {}\n';

describe("PostgreSQL external connections", () => {
    it("adds an unused host port while retaining comments and other settings", () => {
        const result = enablePostgresPort(compose, new Set([15432, 15433]));
        expect(result).toContain("# Keep this comment");
        expect(YAML.parse(result)).toMatchObject({
            services: {
                db: {
                    image: "postgres:18",
                    "x-ports": ["15434:5432/tcp@host"],
                    volumes: ["data:/var/lib/postgresql"],
                },
            },
            volumes: { data: {} },
        });
        expect(postgresService(result)?.published?.port).toBe(15434);
    });

    it("appends to standard ports without mixing ports and x-ports", () => {
        const result = enablePostgresPort("services:\n  db:\n    ports: ['8080:80']\n", new Set());
        expect(YAML.parse(result).services.db).toEqual({
            ports: ["8080:80", { target: 5432, published: 15432, protocol: "tcp", mode: "host" }],
        });
    });

    it("does not mistake unrelated TCP ports for PostgreSQL and is idempotent", () => {
        expect(
            postgresService("services:\n  db:\n    ports: ['8080:80']\n")?.published,
        ).toBeUndefined();
        const result = enablePostgresPort(compose, new Set());
        expect(enablePostgresPort(result, new Set([15432]))).toBe(result);
    });

    it("collects ports across services, long syntax, ranges, IPv6 and Uncloud ingress", () => {
        expect(
            composePublishedPorts(`services:
  db:
    ports:
      - '[::]:15432:5432'
      - target: 5432
        published: '15433-15434'
  web:
    x-ports: ['example.com:80/http', 'example.com:15435:80/http', '15436:5432/tcp@host']
`),
        ).toEqual([15432, 15433, 15434, 15435, 15436]);
    });

    it("fails closed for unresolved published ports and exhausted port space", () => {
        expect(() => publishedPortNumbers("${PORT}:5432")).toThrow();
        expect(() =>
            enablePostgresPort(compose, new Set(Array.from({ length: 65536 }, (_, i) => i))),
        ).toThrow("No unused");
    });
});
