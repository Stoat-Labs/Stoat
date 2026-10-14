import { describe, expect, it } from "vite-plus/test";

import {
    buildProjectGraph,
    composeServices,
    type GraphResourceInput,
} from "../../packages/api/src/project-graph";

const api = "11111111-1111-4111-8111-111111111111";

const db = "22222222-2222-4222-8222-222222222222";

const elsewhere = "33333333-3333-4333-8333-333333333333";

const project = "44444444-4444-4444-8444-444444444444";

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
                    projectId: project,
                    deployed: null,
                    spec: "services:\n  api:\n    image: api\n",
                    draftSpec: null,
                    settings: {
                        env: `DB_URL={{ ${db}.DATABASE_URL }}\nOTHER={{ ${elsewhere}.KEY }}\nSELF={{ ${api}.X }}`,
                    },
                },
                {
                    id: db,
                    projectId: project,
                    deployed: null,
                    spec: null,
                    draftSpec: null,
                    settings: null,
                },
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
                {
                    id: api,
                    projectId: project,
                    deployed: null,
                    spec: null,
                    draftSpec: "services:\n  api: {}\n",
                    settings: null,
                },
                {
                    id: db,
                    projectId: project,
                    deployed: null,
                    spec: "services: [",
                    draftSpec: null,
                    settings: null,
                },
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
                    projectId: project,
                    deployed: null,
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
                    projectId: project,
                    deployed: null,
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

describe("buildProjectGraph staged edits", () => {
    it("shows the draft, flags services that are not deployed yet, and marks the resource changed", () => {
        const {
            resources: [graph],
        } = buildProjectGraph(
            [
                {
                    id: api,
                    projectId: project,
                    deployed: null,
                    spec: "services:\n  web:\n    image: nginx\n",
                    draftSpec: "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n",
                    settings: null,
                },
            ],
            [],
        );

        expect(graph?.services.map((service) => [service.name, service.isNew])).toEqual([
            ["web", false],
            ["db", true],
        ]);
        expect(graph?.changed).toBe(true);
    });

    describe("staged changes", () => {
        const spec = "services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n";

        // Deployed with the default prefix and the given `.env`.
        const deployedRow = (env: string, overrides: Partial<GraphResourceInput> = {}) => ({
            id: api,
            projectId: project,
            spec,
            draftSpec: spec,
            settings: { env },
            deployed: { env, prefix: "44444444-11111111" },
            ...overrides,
        });

        const graphOf = (row: ReturnType<typeof deployedRow>) =>
            buildProjectGraph([row], []).resources[0];

        it("has nothing to apply when the live deploy matches the saved resource", () => {
            expect(graphOf(deployedRow("A=1"))).toMatchObject({ changed: false, removed: [] });
        });

        it("counts a variable edit as a change", () => {
            const row = deployedRow("A=1");

            expect(graphOf({ ...row, settings: { env: "A=2" } })?.changed).toBe(true);
        });

        it("counts a never-deployed resource as a change", () => {
            expect(graphOf(deployedRow("", { spec: null, deployed: null }))?.changed).toBe(true);
        });

        it("lists a renamed or deleted service as removed", () => {
            const row = deployedRow("", {
                draftSpec: "services:\n  app:\n    image: nginx\n  worker:\n    image: busybox\n",
            });

            expect(graphOf(row)).toMatchObject({ changed: true, removed: ["web"] });
        });

        it("replaces every service when the prefix setting changes", () => {
            const row = deployedRow("", { settings: { env: "", prefixNames: false } });

            expect(graphOf(row)).toMatchObject({ changed: true, removed: ["web", "worker"] });
        });
    });
});
