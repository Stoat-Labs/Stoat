import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import {
    ComposeMoveError,
    moveComposeService,
    retargetServiceReferences,
} from "../../packages/api/src/compose/move";
import { buildProjectGraph } from "../../packages/api/src/project-graph";
import {
    formatComposeFile,
    interpolateCompose,
    resourceComposePrefix,
} from "../../packages/workflows/src/compose";
import { referencedResourceIds, resolveReferences } from "../../packages/workflows/src/references";

const PROJECT_ID = "cccccccc-0000-4000-8000-000000000000";

const DOMAIN = "example.test";

const STACK = "aaaaaaaa-0000-4000-8000-000000000001";

// A frozen single-stack Seafile: a real-world monolith to exercise moving services between resources.
const template = (file: string) =>
    readFileSync(new URL(`./fixtures/seafile/${file}`, import.meta.url), "utf8");

const seafileCompose = template("compose.yaml");

const seafileEnv = template(".env").replace(
    "SEAFILE_SERVER_HOSTNAME=",
    "SEAFILE_SERVER_HOSTNAME=files.example.test",
);

/** A resource: `compose` is the saved draft, `live` the spec its last deploy ran, if any. */
type Stack = { id: string; compose: string; env: string; prefixNames: boolean; live?: string };

function newId(index: number) {
    return `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const settingsOf = (stack: Stack) => ({ env: stack.env, prefixNames: stack.prefixNames });

// Ids here differ only at the end, so slugs come from that.
const slugOf = (stack: Stack) => `stack-${stack.id.slice(-6)}`;

const prefixOf = (stack: Stack) =>
    resourceComposePrefix({ slug: slugOf(stack), settings: settingsOf(stack) });

/** The name a service runs under on the cluster, as prefixing deploys it. */
function host(stack: Stack, service: string) {
    const prefix = prefixOf(stack);

    return prefix ? `${prefix}-${service}` : service;
}

function find(stacks: Stack[], id: string) {
    const stack = stacks.find((candidate) => candidate.id === id);

    if (!stack) throw new Error(`No stack ${id}`);

    return stack;
}

/** What `moveService` does: both resources, removal of an empty source, and other readers. */
function move(stacks: Stack[], fromId: string, service: string, toId: string) {
    const from = find(stacks, fromId);

    const to = stacks.find((stack) => stack.id === toId) ?? {
        id: toId,
        compose: "",
        env: "",
        prefixNames: from.prefixNames,
    };

    const result = moveComposeService({
        service,
        source: from.compose,
        target: to.compose,
        sourceId: from.id,
        targetId: to.id,
        sourcePrefix: prefixOf(from),
        sourceEnv: from.env,
        targetEnv: to.env,
    });

    const others = stacks.flatMap((stack) =>
        stack.id === from.id || stack.id === to.id
            ? []
            : [{ ...stack, env: retargetServiceReferences(stack.env, from.id, to.id, service) }],
    );

    return [
        ...others,
        ...(result.sourceEmpty ? [] : [{ ...from, compose: result.source, env: result.sourceEnv }]),
        { ...to, compose: result.target, env: result.targetEnv },
    ];
}

/** The Compose file a deploy hands Uncloud: references resolved, interpolated, prefixed. */
function deploy(stacks: Stack[], id: string) {
    const stack = find(stacks, id);
    const prefix = prefixOf(stack);

    const targets = stacks.map((other) => ({
        id: other.id,
        name: other.id,
        slug: slugOf(other),
        projectId: PROJECT_ID,
        projectName: "Seafile",
        settings: settingsOf(other),
        // Like `referenceTargets`: what is running, with the draft for what isn't yet.
        spec: other.live ?? other.compose,
        draftSpec: other.compose,
    }));

    const references = resolveReferences(stack.env, targets, DOMAIN, stack.id);

    const spec = interpolateCompose(stack.compose, stack.env, prefix, DOMAIN, references, {
        projectId: PROJECT_ID,
        projectName: "Seafile",
        resourceId: stack.id,
        resourceName: stack.id,
    });

    return YAML.parse(formatComposeFile(spec, prefix).yaml);
}

/** The id of the stack running `service`. */
function home(stacks: Stack[], service: string) {
    const stack = stacks.find((candidate) =>
        Object.hasOwn(YAML.parse(candidate.compose).services, service),
    );

    if (!stack) throw new Error(`Nobody runs ${service}`);

    return stack;
}

/** Remove Group on the Seafile stack: every service but the first gets a resource of its own. */
function ungroupSeafile(prefixNames = true) {
    let stacks: Stack[] = [
        { id: STACK, compose: seafileCompose, env: seafileEnv, prefixNames, live: seafileCompose },
    ];

    ["cache", "server", "seadoc"].forEach((service, index) => {
        stacks = move(stacks, STACK, service, newId(index + 1));
    });

    return stacks;
}

function graphEdges(stacks: Stack[]) {
    const graph = buildProjectGraph(
        stacks.map((stack) => ({
            id: stack.id,
            slug: slugOf(stack),
            projectId: PROJECT_ID,
            spec: null,
            draftSpec: stack.compose,
            settings: settingsOf(stack),
            deployed: null,
            attempted: null,
        })),
        [],
    );

    return Object.fromEntries(
        graph.resources.map((resource) => [resource.id, [...resource.references].sort()]),
    );
}

describe("ungrouping the Seafile template", () => {
    it("deploys every service pointing at the others' real names on the cluster", () => {
        const stacks = ungroupSeafile();
        const db = home(stacks, "db");
        const cache = home(stacks, "cache");
        const server = home(stacks, "server");
        const seadoc = home(stacks, "seadoc");

        expect(new Set([db.id, cache.id, server.id, seadoc.id]).size).toBe(4);

        const serverService = deploy(stacks, server.id).services[host(server, "server")];

        expect(serverService.environment).toMatchObject({
            SEAFILE_MYSQL_DB_HOST: host(db, "db"),
            REDIS_HOST: host(cache, "cache"),
        });
        expect(serverService["x-caddy"]).toContain(
            `reverse_proxy {{upstreams "${host(seadoc, "seadoc")}" 80}}`,
        );
        // The server's own upstream is still its own.
        expect(serverService["x-caddy"]).toContain("reverse_proxy {{upstreams 80}}");

        expect(
            deploy(stacks, seadoc.id).services[host(seadoc, "seadoc")].environment,
        ).toMatchObject({
            DB_HOST: host(db, "db"),
            SEAHUB_SERVICE_URL: `http://${host(server, "server")}`,
        });

        // Every resource deploys on its own, including the ones nothing references.
        expect(() => deploy(stacks, db.id)).not.toThrow();
        expect(() => deploy(stacks, cache.id)).not.toThrow();
    });

    it("draws the dependencies the services had as reference edges", () => {
        const stacks = ungroupSeafile();
        const edges = graphEdges(stacks);

        expect(edges[home(stacks, "server").id]).toEqual(
            [home(stacks, "db").id, home(stacks, "cache").id, home(stacks, "seadoc").id].sort(),
        );
        expect(edges[home(stacks, "seadoc").id]).toEqual(
            [home(stacks, "db").id, home(stacks, "server").id].sort(),
        );
        expect(edges[home(stacks, "db").id]).toEqual([]);
        expect(edges[home(stacks, "cache").id]).toEqual([]);
    });

    it("leaves no links behind in the stack once their service moved on", () => {
        const stacks = ungroupSeafile();

        expect(find(stacks, STACK).env).toBe(seafileEnv);
    });

    it("keeps an unprefixed stack's bare names working", () => {
        const stacks = ungroupSeafile(false);
        const server = home(stacks, "server");

        expect(deploy(stacks, server.id).services.server.environment).toMatchObject({
            SEAFILE_MYSQL_DB_HOST: "db",
            REDIS_HOST: "cache",
        });
        expect(deploy(stacks, server.id).services.server["x-caddy"]).toContain(
            'reverse_proxy {{upstreams "seadoc" 80}}',
        );
    });

    it.each([
        ["seadoc", "server", "cache"],
        ["server", "cache", "seadoc"],
        ["cache", "seadoc", "server"],
    ])("merges back (%s, %s, %s) to the original stack, minus depends_on", (...order) => {
        let stacks = ungroupSeafile();

        for (const service of order)
            stacks = move(stacks, home(stacks, service).id, service, STACK);

        expect(stacks).toHaveLength(1);

        const [merged] = stacks;
        const original = YAML.parse(seafileCompose);
        const result = YAML.parse(merged!.compose);

        for (const service of Object.keys(original.services)) {
            delete original.services[service].depends_on;
            expect(result.services[service]).toEqual(original.services[service]);
        }

        expect(merged!.env).toBe(seafileEnv);
        expect(referencedResourceIds(merged!.env)).toEqual([]);

        const server = deploy(stacks, STACK).services[host(merged!, "server")];

        expect(server.environment.REDIS_HOST).toBe(host(merged!, "cache"));
        expect(server["x-caddy"]).toContain(`{{upstreams "${host(merged!, "seadoc")}" 80}}`);
    });

    it("deploys the stack first when its database joins a resource that is already running", () => {
        const running = "services:\n  web:\n    image: nginx\n";

        let stacks: Stack[] = [
            {
                id: STACK,
                compose: seafileCompose,
                env: seafileEnv,
                prefixNames: true,
                live: seafileCompose,
            },
            { id: newId(7), compose: running, env: "", prefixNames: true, live: running },
        ];

        // Apply deploys the resource losing a service first, before the target runs it.
        stacks = move(stacks, STACK, "db", newId(7));

        const target = find(stacks, newId(7));

        expect(target.live).toBe(running);
        expect(
            deploy(stacks, STACK).services[host(find(stacks, STACK), "server")].environment
                .SEAFILE_MYSQL_DB_HOST,
        ).toBe(host(target, "db"));
    });

    it("survives regrouping into a different stack than the one it came from", () => {
        let stacks = ungroupSeafile();
        const seadoc = home(stacks, "seadoc");

        // seadoc joins the server's resource, then the cache moves in as well.
        stacks = move(stacks, seadoc.id, "seadoc", home(stacks, "server").id);
        stacks = move(stacks, home(stacks, "cache").id, "cache", home(stacks, "server").id);

        const server = home(stacks, "server");

        expect(stacks).toHaveLength(2);

        const deployed = deploy(stacks, server.id).services;

        expect(deployed[host(server, "server")].environment).toMatchObject({
            REDIS_HOST: host(server, "cache"),
            SEAFILE_MYSQL_DB_HOST: host(home(stacks, "db"), "db"),
        });
        expect(deployed[host(server, "seadoc")].environment.SEAHUB_SERVICE_URL).toBe(
            `http://${host(server, "server")}`,
        );
        // Only the database still lives elsewhere.
        expect(referencedResourceIds(server.env)).toEqual([STACK]);
        expect(YAML.parse(server.compose).services.server.environment.REDIS_HOST).toBe(
            "${CACHE_SERVICE_NAME}",
        );
    });
});

const app = `services:
  web:
    image: nginx
    environment:
      CACHE_URL: http://cache.internal:6379
      REDIS: redis://:pw@cache:6379/0
      PORT: 8080
      DEBUG: true
      HEADER: cache-control
      EXTERNAL: https://example.com/cache
      SELF: http://web
      LIST: cache
      CACHE_HOST: \${CACHE_HOST}
  cache:
    image: redis
    environment:
      - PEER=web
      - BARE
`;

function split(options: { compose?: string; env?: string; service?: string } = {}) {
    return move(
        [{ id: STACK, compose: options.compose ?? app, env: options.env ?? "", prefixNames: true }],
        STACK,
        options.service ?? "cache",
        newId(9),
    );
}

describe("hostnames across resources", () => {
    it("rewrites only real hostnames, keeping .internal, ports and credentials", () => {
        const stacks = split();
        const web = YAML.parse(find(stacks, STACK).compose).services.web.environment;

        expect(web).toEqual({
            CACHE_URL: "http://${CACHE_SERVICE_NAME}.internal:6379",
            REDIS: "redis://:pw@${CACHE_SERVICE_NAME}:6379/0",
            PORT: 8080,
            DEBUG: true,
            HEADER: "cache-control",
            EXTERNAL: "https://example.com/cache",
            SELF: "http://web",
            LIST: "${CACHE_SERVICE_NAME}",
            CACHE_HOST: "${CACHE_HOST}",
        });

        const cache = host(find(stacks, newId(9)), "cache");
        const deployed = deploy(stacks, STACK).services[host(find(stacks, STACK), "web")];

        expect(deployed.environment).toMatchObject({
            CACHE_URL: `http://${cache}.internal:6379`,
            REDIS: `redis://:pw@${cache}:6379/0`,
        });
    });

    it("rewrites list-style environment entries in the moved service", () => {
        const stacks = split();
        const moved = find(stacks, newId(9));

        expect(YAML.parse(moved.compose).services.cache.environment).toEqual([
            "PEER=${WEB_SERVICE_NAME}",
            "BARE",
        ]);
        expect(moved.env).toBe(`WEB_SERVICE_NAME={{ ${STACK}.WEB_SERVICE_NAME }}\n`);
        expect(deploy(stacks, moved.id).services[host(moved, "cache")].environment).toContain(
            `PEER=${host(find(stacks, STACK), "web")}`,
        );
    });

    it("rewrites hostnames in the Variables the remaining services use, keeping quotes and comments", () => {
        const env = [
            "CACHE_HOST=cache # where redis lives",
            'QUOTED="redis://cache:6379"',
            "UNUSED=cache",
            "MULTI='cache",
            "cache'",
            "",
        ].join("\n");

        const stacks = split({
            env,
            compose: app.replace("SELF: http://web", "SELF: ${QUOTED}${MULTI}"),
        });

        const source = find(stacks, STACK);
        const target = newId(9);

        expect(source.env).toBe(
            [
                `CACHE_HOST={{ ${target}.CACHE_SERVICE_NAME }} # where redis lives`,
                `QUOTED="redis://{{ ${target}.CACHE_SERVICE_NAME }}:6379"`,
                // Nothing left behind reads it, and multiline values are never edited in place.
                "UNUSED=cache",
                "MULTI='cache",
                "cache'",
                `CACHE_SERVICE_NAME={{ ${target}.CACHE_SERVICE_NAME }}`,
                "",
            ].join("\n"),
        );

        const deployed = deploy(stacks, STACK).services[host(source, "web")].environment;
        const cache = host(find(stacks, target), "cache");

        expect(deployed.CACHE_HOST).toBe(cache);
        expect(deployed.SELF).toBe(`redis://${cache}:6379cache\ncache`);
    });

    it("rewrites hostnames in the Variables the moved service takes along", () => {
        const stacks = split({
            service: "web",
            env: "DATABASE_URL=postgres://u:p@cache:5432/app\n",
            compose: app.replace("SELF: http://web", "DB: ${DATABASE_URL}"),
        });

        const moved = find(stacks, newId(9));

        expect(parseEnv(moved.env).DATABASE_URL).toBe(
            `postgres://u:p@{{ ${STACK}.CACHE_SERVICE_NAME }}:5432/app`,
        );
        // The source keeps its own value, since the cache still runs there, and its cache now
        // reaches the moved web service through a link.
        expect(find(stacks, STACK).env).toBe(
            `DATABASE_URL=postgres://u:p@cache:5432/app\nWEB_SERVICE_NAME={{ ${newId(9)}.WEB_SERVICE_NAME }}\n`,
        );
        expect(deploy(stacks, moved.id).services[host(moved, "web")].environment.DB).toBe(
            `postgres://u:p@${host(find(stacks, STACK), "cache")}:5432/app`,
        );
    });

    it("picks a free variable name instead of overriding one", () => {
        const stacks = split({ env: "CACHE_SERVICE_NAME=mine\nCACHE_SERVICE_NAME_2=also-mine\n" });
        const source = find(stacks, STACK);

        expect(parseEnv(source.env)).toMatchObject({
            CACHE_SERVICE_NAME: "mine",
            CACHE_SERVICE_NAME_2: "also-mine",
            CACHE_SERVICE_NAME_3: `{{ ${newId(9)}.CACHE_SERVICE_NAME }}`,
        });
        expect(YAML.parse(source.compose).services.web.environment.LIST).toBe(
            "${CACHE_SERVICE_NAME_3}",
        );
    });

    it("reuses a link that already exists instead of adding another", () => {
        const link = `CACHE_SERVICE_NAME={{ ${newId(9)}.CACHE_SERVICE_NAME }}`;
        const stacks = split({ env: `${link}\n` });

        expect(find(stacks, STACK).env).toBe(`${link}\n`);
    });

    it("never names another service's built-ins", () => {
        expect(() =>
            moveComposeService({
                service: "web-app",
                source: "services:\n  web-app:\n    image: a\n  api:\n    image: b\n    environment:\n      UP: http://web-app\n",
                target: "services:\n  web_app:\n    image: c\n",
                sourceId: STACK,
                targetId: newId(9),
                sourcePrefix: undefined,
                sourceEnv: "",
                targetEnv: "",
            }),
        ).toThrow(ComposeMoveError);
    });

    it("collapses a reference to the target into its built-in when the service joins it", () => {
        const target = newId(9);

        const stacks: Stack[] = [
            {
                id: STACK,
                compose: "services:\n  cache:\n    image: redis\n  extra:\n    image: x\n",
                env: "",
                prefixNames: true,
            },
            {
                id: target,
                compose:
                    "services:\n  web:\n    image: nginx\n    environment:\n      URL: redis://${CACHE_SERVICE_NAME}:6379\n",
                env: `CACHE_SERVICE_NAME={{ ${STACK}.CACHE_SERVICE_NAME }}\nOTHER={{ ${STACK}.EXTRA_SERVICE_NAME }}\n`,
                prefixNames: true,
            },
        ];

        const merged = find(move(stacks, STACK, "cache", target), target);

        expect(YAML.parse(merged.compose).services.web.environment.URL).toBe(
            "redis://${CACHE_SERVICE_NAME}:6379",
        );
        expect(merged.env).toBe(`OTHER={{ ${STACK}.EXTRA_SERVICE_NAME }}\n`);
    });
});

describe("moves next to unrelated services", () => {
    it("keeps what stays behind pointing at its own services when the target has the same names", () => {
        const result = moveComposeService({
            service: "cache",
            source: "services:\n  web:\n    image: nginx\n    environment:\n      SELF: http://web\n      UP: http://cache\n  cache:\n    image: redis\n",
            target: "services:\n  web:\n    image: other\n",
            sourceId: STACK,
            targetId: newId(9),
            sourcePrefix: undefined,
            sourceEnv: "",
            targetEnv: "",
        });

        expect(YAML.parse(result.source).services.web.environment).toEqual({
            SELF: "http://web",
            UP: "http://${CACHE_SERVICE_NAME}",
        });
    });

    it("keeps a collapsed link that other parts of the Compose still interpolate", () => {
        const target = newId(9);

        const result = moveComposeService({
            service: "cache",
            source: "services:\n  cache:\n    image: redis\n  extra:\n    image: x\n",
            target: 'services:\n  app:\n    image: a\n    command: ["connect", "${HOST}"]\n',
            sourceId: STACK,
            targetId: target,
            sourcePrefix: undefined,
            sourceEnv: "",
            targetEnv: `HOST={{ ${STACK}.CACHE_SERVICE_NAME }}\n`,
        });

        expect(result.targetEnv).toBe("HOST=${CACHE_SERVICE_NAME}\n");
        expect(YAML.parse(result.target).services.app.command).toEqual(["connect", "${HOST}"]);
    });
});

describe("retargetServiceReferences", () => {
    const from = STACK;
    const to = newId(9);

    it("moves only the service's built-ins on the old resource", () => {
        const env = [
            `A={{ ${from}.CACHE_SERVICE_NAME }}`,
            `B=http://{{ ${from.toUpperCase()}.CACHE_INTERNAL_HOST }}:80`,
            `C={{ ${from}.CACHE_PUBLIC_DOMAIN }}`,
            `D={{ ${from}.WEB_SERVICE_NAME }}`,
            `E={{ ${from}.CACHE_PASSWORD }}`,
            `F={{ ${to}.CACHE_SERVICE_NAME }}`,
            "",
        ].join("\n");

        expect(retargetServiceReferences(env, from, to, "cache")).toBe(
            [
                `A={{ ${to}.CACHE_SERVICE_NAME }}`,
                `B=http://{{ ${to}.CACHE_INTERNAL_HOST }}:80`,
                `C={{ ${to}.CACHE_PUBLIC_DOMAIN }}`,
                `D={{ ${from}.WEB_SERVICE_NAME }}`,
                `E={{ ${from}.CACHE_PASSWORD }}`,
                `F={{ ${to}.CACHE_SERVICE_NAME }}`,
                "",
            ].join("\n"),
        );
    });

    it("returns the same text when nothing points at the service", () => {
        const env = "# comment\nA=1\nB='x\ny'\n";

        expect(retargetServiceReferences(env, from, to, "cache")).toBe(env);
    });
});
