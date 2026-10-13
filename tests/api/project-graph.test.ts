import { describe, expect, it } from "vite-plus/test";

import { buildProjectGraph, composeServices } from "../../packages/api/src/project-graph";

const api = "11111111-1111-4111-8111-111111111111";

const db = "22222222-2222-4222-8222-222222222222";

const elsewhere = "33333333-3333-4333-8333-333333333333";

describe("composeServices", () => {
    it("reads both depends_on forms and keeps only named volumes", () => {
        const services = composeServices(`services:
  web:
    image: nginx
    depends_on: [api, missing]
  api:
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./config:/etc/api
      - /tmp/cache
  db:
    image: \${DB_IMAGE:-postgres}:\${DB_TAG-18}
    volumes:
      - pg-data:/var/lib/postgresql/data
      - type: volume
        source: wal
        target: /wal
      - type: bind
        source: /srv
        target: /srv
`);

        expect(services).toEqual([
            { name: "web", image: "nginx", dependsOn: ["api"], volumes: [] },
            { name: "api", image: undefined, dependsOn: ["db"], volumes: [] },
            { name: "db", image: "postgres:18", dependsOn: [], volumes: ["pg-data", "wal"] },
        ]);
    });
});

describe("buildProjectGraph", () => {
    it("keeps references to resources in the same project only", () => {
        const {
            resources: [graph],
        } = buildProjectGraph(
            [
                {
                    id: api,
                    spec: "services:\n  api:\n    image: api\n",
                    draftSpec: null,
                    settings: {
                        env: `DB_URL={{ ${db}.DATABASE_URL }}\nOTHER={{ ${elsewhere}.KEY }}\nSELF={{ ${api}.X }}`,
                    },
                },
                { id: db, spec: null, draftSpec: null, settings: null },
            ],
            [],
        );

        expect(graph?.references).toEqual([db]);
        expect(graph?.draftOnly).toBe(false);
    });

    it("falls back to the draft and flags broken specs without failing", () => {
        const {
            resources: [draft, broken],
        } = buildProjectGraph(
            [
                { id: api, spec: null, draftSpec: "services:\n  api: {}\n", settings: null },
                { id: db, spec: "services: [", draftSpec: null, settings: null },
            ],
            [],
        );

        expect(draft).toMatchObject({ draftOnly: true, parseError: false });
        expect(draft?.services.map((service) => service.name)).toEqual(["api"]);
        expect(broken).toMatchObject({ parseError: true, services: [] });
    });
});

describe("buildProjectGraph logos", () => {
    it("matches images a template runs under its own name, once per template", () => {
        const template = {
            appId: "seafile",
            logo: "data:image/svg+xml,seafile",
            versions: {
                pro: {
                    compose:
                        "services:\n  db:\n    image: mariadb:10.11\n  app:\n    image: seafileltd/seafile-pro-mc:13\n",
                    env: "",
                },
            },
        };

        const { resources, logos } = buildProjectGraph(
            [
                {
                    id: api,
                    spec: "services:\n  db:\n    image: mariadb\n  seafile:\n    image: ${IMAGE:-seafileltd/seafile-pro-mc:13.0-latest}\n",
                    draftSpec: null,
                    settings: null,
                },
            ],
            [template],
        );

        expect(resources[0]?.services.map((service) => service.template)).toEqual([
            undefined,
            "seafile",
        ]);
        expect(logos).toEqual({ seafile: "data:image/svg+xml,seafile" });
    });
});

describe("buildProjectGraph domains", () => {
    it("lists each service's public HTTP hostnames, not raw host ports", () => {
        const { resources } = buildProjectGraph(
            [
                {
                    id: api,
                    spec: "services:\n  web:\n    image: nginx\n    x-ports:\n      - app.example.com:80/https\n      - 5432:5432/tcp@host\n  db:\n    image: postgres\n",
                    draftSpec: null,
                    settings: null,
                },
            ],
            [],
        );

        expect(resources[0]?.services.map((service) => service.domains)).toEqual([
            ["app.example.com"],
            [],
        ]);
    });
});
