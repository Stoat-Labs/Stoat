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
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
                    spec: "services:\n  api:\n    image: api\n",
                    draftSpec: null,
                    settings: {
                        env: `DB_URL={{ ${db}.DATABASE_URL }}\nOTHER={{ ${elsewhere}.KEY }}\nSELF={{ ${api}.X }}`,
                    },
                },
                {
                    id: db,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
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
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
                    spec: null,
                    draftSpec: "services:\n  api: {}\n",
                    settings: null,
                },
                {
                    id: db,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
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

    it("stages a deletion as a change that removes every deployed service", () => {
        const spec = "services:\n  api: {}\n  worker: {}\n";

        const {
            resources: [graph],
        } = buildProjectGraph(
            [
                {
                    id: api,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: { env: "", prefix: "" },
                    attempted: { spec, env: "", prefix: "", failed: false },
                    spec,
                    draftSpec: spec,
                    pendingDelete: true,
                    settings: null,
                },
            ],
            [],
        );

        expect(graph).toMatchObject({
            changed: true,
            pendingDelete: true,
            removed: ["api", "worker"],
        });
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
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
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
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
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

    it("lists hostless HTTP ports at the prefixed service on the cluster domain", () => {
        const { resources } = buildProjectGraph(
            [
                {
                    id: api,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
                    spec: "services:\n  web:\n    image: nginx\n    x-ports:\n      - 80/https\n",
                    draftSpec: null,
                    settings: null,
                },
            ],
            [],
            "abc123.uncld.dev",
        );

        expect(resources[0]?.services[0]?.domains).toEqual(["graph-k3f9x2-web.abc123.uncld.dev"]);
    });

    it("lists x-caddy site addresses resolved through the .env", () => {
        const { resources } = buildProjectGraph(
            [
                {
                    id: api,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
                    spec: 'services:\n  web:\n    image: nginx\n    x-caddy: |\n      ${HOST:?Variable is not set} {\n        handle_path /api/* {\n          reverse_proxy {{upstreams "api" 80}}\n        }\n        reverse_proxy {{upstreams 80}}\n      }\n',
                    draftSpec: null,
                    settings: { env: "HOST=files.example.com\n" },
                },
            ],
            [],
        );

        expect(resources[0]?.services.map((service) => service.domains)).toEqual([
            ["files.example.com"],
        ]);
    });

    it("resolves volume mounts through the .env", () => {
        const { resources } = buildProjectGraph(
            [
                {
                    id: api,
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
                    spec: 'services:\n  db:\n    image: mariadb\n    volumes:\n      - "${DB_VOLUME:-/opt/db}:/var/lib/mysql"\nvolumes:\n  db-data: {}\n',
                    draftSpec: null,
                    settings: { env: "DB_VOLUME=db-data\n" },
                },
            ],
            [],
        );

        expect(resources[0]?.services[0]?.volumes).toEqual(["db-data"]);
        expect(resources[0]?.volumes).toEqual([
            {
                name: "db-data",
                services: ["db"],
                mounts: [{ service: "db", target: "/var/lib/mysql" }],
            },
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
                    slug: "graph-k3f9x2",
                    projectId: project,
                    deployed: null,
                    attempted: null,
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
            slug: "api-k3f9x2",
            projectId: project,
            spec,
            draftSpec: spec,
            settings: { env },
            deployed: { env, prefix: "api-k3f9x2" },
            attempted: null,
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

        it("has nothing to apply once a deploy shipped the draft, even if it failed", () => {
            const draftSpec = "services:\n  app:\n    image: nginx\n";

            const row = deployedRow("A=2", {
                draftSpec,
                deployed: { env: "A=1", prefix: "api-k3f9x2" },
                attempted: { spec: draftSpec, env: "A=2", prefix: "api-k3f9x2", failed: false },
            });

            // What runs is still the last ready deploy, so its services are still the ones removed.
            expect(graphOf(row)).toMatchObject({ changed: false, removed: ["web", "worker"] });
            expect(graphOf({ ...row, settings: { env: "A=3" } })?.changed).toBe(true);
        });

        it("keeps a failed deploy's unfinished removals staged so Apply retries the cleanup", () => {
            const draftSpec = "services:\n  app:\n    image: nginx\n";

            const row = deployedRow("A=2", {
                draftSpec,
                deployed: { env: "A=1", prefix: "api-k3f9x2" },
                attempted: { spec: draftSpec, env: "A=2", prefix: "api-k3f9x2", failed: true },
            });

            expect(graphOf(row)).toMatchObject({ changed: true, removed: ["web", "worker"] });
            // Nothing left to remove, so a failed deploy of the same draft is not staged again.
            expect(graphOf({ ...row, spec: draftSpec })).toMatchObject({
                changed: false,
                removed: [],
            });
        });

        it("does not list a service moved into another resource as removed", () => {
            const draftSpec = "services:\n  web:\n    image: nginx\n";

            const row = deployedRow("", {
                draftSpec,
                attempted: { spec: draftSpec, env: "", prefix: "api-k3f9x2", failed: true },
            });

            const owner = deployedRow("", {
                id: db,
                spec: "services:\n  worker:\n    image: busybox\n",
            });

            expect(buildProjectGraph([row, owner], []).resources[0]).toMatchObject({
                changed: false,
                removed: [],
            });
        });

        it("has nothing to apply once a never-deployed resource's first deploy is shipped", () => {
            const row = deployedRow("", {
                spec: null,
                deployed: null,
                attempted: { spec, env: "", prefix: "api-k3f9x2", failed: false },
            });

            expect(graphOf(row)?.changed).toBe(false);
        });

        it("replaces every service when the prefix setting changes", () => {
            const row = deployedRow("", { settings: { env: "", prefixNames: false } });

            expect(graphOf(row)).toMatchObject({ changed: true, removed: ["web", "worker"] });
        });
    });
});
