import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
    assertNoComposeReference,
    ComposeVariableError,
    composeSystemVariables,
    composeVariables,
    interpolateCompose,
} from "../../packages/workflows/src/compose";
import {
    referencedResourceIds,
    referenceKeys,
    referenceVariables,
    resolveReferences,
    type ReferenceTarget,
} from "../../packages/workflows/src/references";
import {
    referenceResourceId,
    VARIABLE_REFERENCE,
} from "../../packages/workflows/src/variable-reference";

const POSTGRES_ID = "11111111-2222-4333-8444-555555555555";

const REDIS_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const MISSING_ID = "99999999-2222-4333-8444-555555555555";

const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// Slugs in the shape migrated resources got, so prefixes read like `aaaaaaaa-11111111-db`.
function target(id: string, name: string, env: string, spec: string): ReferenceTarget {
    const slug = `${PROJECT_ID.slice(0, 8)}-${id.slice(0, 8)}`;

    return { id, name, slug, projectId: PROJECT_ID, projectName: "Shop", settings: { env }, spec };
}

const postgres = target(
    POSTGRES_ID,
    "postgres",
    [
        "POSTGRES_USER=shop",
        "POSTGRES_PASSWORD=pa$$word",
        // Sorts before POSTGRES_USER: file order, not key order, decides what is defined.
        "DATABASE_URL=postgres://${POSTGRES_USER}@${DB_INTERNAL_HOST}:5432",
        "EMPTY=",
        "LITERAL=$$HOME",
        "MIXED=a\"b'c`d",
        "APP_URL=https://app.${STOAT_DOMAIN}",
        "UPSTREAM={{ " + REDIS_ID + ".URL }}",
    ].join("\n"),
    "services:\n  db:\n    image: postgres\n",
);

const redis = target(
    REDIS_ID,
    "redis",
    "URL=redis://${CACHE_INTERNAL_HOST}:6379\nBACK={{ " + POSTGRES_ID + ".POSTGRES_USER }}\n",
    "services:\n  cache:\n    image: redis\n",
);

const ref = (id: string, key: string) => `{{ ${id}.${key} }}`;

describe("reference syntax", () => {
    it.each([
        [`{{ ${POSTGRES_ID}.KEY }}`, POSTGRES_ID, "KEY"],
        [`{{${POSTGRES_ID}.KEY}}`, POSTGRES_ID, "KEY"],
        [`{{   ${POSTGRES_ID}.lower_key   }}`, POSTGRES_ID, "lower_key"],
        [`{{ ${POSTGRES_ID}.dotted.key-name }}`, POSTGRES_ID, "dotted.key-name"],
        ["{{ postgres.KEY }}", "postgres", "KEY"],
    ])("matches %s", (text, id, key) => {
        expect([...text.matchAll(VARIABLE_REFERENCE)].map((m) => [m[1], m[2]])).toEqual([
            [id, key],
        ]);
    });

    it.each([
        "{{ UUID }}",
        "{{ 32 }}",
        "{{ DNS }}",
        "{{ .Name }}",
        "{{.Names}}",
        "{{ }}",
        "{ x.Y }",
        "${POSTGRES_USER}",
        "plain text",
    ])("ignores %s", (text) => {
        expect(text.match(VARIABLE_REFERENCE)).toBeNull();
    });

    it("normalizes resource ids and rejects anything else", () => {
        expect(referenceResourceId(POSTGRES_ID.toUpperCase())).toBe(POSTGRES_ID);
        expect(referenceResourceId(POSTGRES_ID)).toBe(POSTGRES_ID);
        expect(referenceResourceId("postgres")).toBeUndefined();
        expect(referenceResourceId(`${POSTGRES_ID}0`)).toBeUndefined();
        expect(referenceResourceId("11111111-2222-4333-8444-55555555555g")).toBeUndefined();
    });
});

describe("referencedResourceIds", () => {
    it("collects unique lowercase ids from values only", () => {
        const env = [
            "# COMMENTED=" + ref(MISSING_ID, "KEY"),
            "A=" + ref(POSTGRES_ID, "X") + "-" + ref(POSTGRES_ID.toUpperCase(), "Y"),
            `export B="${ref(REDIS_ID, "Z")}"`,
            "C='" + ref(POSTGRES_ID, "W") + "'",
            "D={{ postgres.KEY }}",
        ].join("\n");

        expect(referencedResourceIds(env)).toEqual([POSTGRES_ID, REDIS_ID]);
    });

    it("returns nothing for env without references", () => {
        expect(referencedResourceIds("")).toEqual([]);
        expect(referencedResourceIds("A={{ UUID }}\nB={{ 32 }}\nC={{ .Name }}\n")).toEqual([]);
    });
});

describe("referenceVariables", () => {
    it("exposes built-ins and the target's own resolved env in its own context", () => {
        const variables = referenceVariables(postgres, "example.com");

        expect(variables).toMatchObject({
            DB_INTERNAL_HOST: "aaaaaaaa-11111111-db.internal",
            DB_SERVICE_NAME: "aaaaaaaa-11111111-db",
            STOAT_PREFIX: "aaaaaaaa-11111111",
            STOAT_DOMAIN: "example.com",
            POSTGRES_USER: "shop",
            POSTGRES_PASSWORD: "pa$word",
            DATABASE_URL: "postgres://shop@aaaaaaaa-11111111-db.internal:5432",
            EMPTY: "",
            LITERAL: "$HOME",
            APP_URL: "https://app.example.com",
        });
    });

    it("keeps unprefixed names when the target opts out of prefixing", () => {
        const plain = { ...postgres, settings: { env: "", prefixNames: false } };

        expect(referenceVariables(plain)).toMatchObject({
            DB_INTERNAL_HOST: "db.internal",
            STOAT_PREFIX: "",
        });
    });

    it("names the target when its variables cannot be read", () => {
        const broken = { ...postgres, spec: "services: [" };
        const required = { ...postgres, settings: { env: "A=${MISSING:?set it}" } };

        expect(() => referenceVariables(broken)).toThrow(
            new ComposeVariableError(
                'Unable to read variables from "postgres": Invalid compose YAML',
            ),
        );
        expect(() => referenceVariables(required)).toThrow(
            /Unable to read variables from "postgres"/u,
        );
    });

    it("tolerates missing or malformed settings", () => {
        expect(referenceVariables({ ...postgres, settings: null })).toMatchObject({
            DB_INTERNAL_HOST: "aaaaaaaa-11111111-db.internal",
        });
        expect(referenceVariables({ ...postgres, settings: { env: 42 } })).not.toHaveProperty(
            "POSTGRES_USER",
        );
    });
});

describe("resolveReferences before the target deploys a moved-in service", () => {
    // Deployed with only `db`; the saved draft also runs `cache`, moved in from another resource.
    const moving = {
        ...postgres,
        settings: { env: "" },
        draftSpec: "services:\n  db:\n    image: postgres\n  cache:\n    image: redis\n",
    };

    it("falls back to the draft for keys the deployed spec doesn't have", () => {
        expect(
            resolveReferences(`HOST=${ref(POSTGRES_ID, "CACHE_SERVICE_NAME")}`, [moving]),
        ).toEqual({ [`${POSTGRES_ID}.CACHE_SERVICE_NAME`]: "aaaaaaaa-11111111-cache" });
    });

    it("keeps answering from the deployed spec while it has the key", () => {
        const dropping = { ...moving, draftSpec: "services:\n  cache:\n    image: redis\n" };

        expect(
            resolveReferences(`HOST=${ref(POSTGRES_ID, "DB_SERVICE_NAME")}`, [dropping]),
        ).toEqual({ [`${POSTGRES_ID}.DB_SERVICE_NAME`]: "aaaaaaaa-11111111-db" });
    });

    it("still fails for keys neither has, and for a broken draft", () => {
        const env = `HOST=${ref(POSTGRES_ID, "GHOST_SERVICE_NAME")}`;

        expect(() => resolveReferences(env, [moving])).toThrow(
            'Resource "postgres" has no variable GHOST_SERVICE_NAME.',
        );
        expect(() => resolveReferences(env, [{ ...moving, draftSpec: "services: [" }])).toThrow(
            'Resource "postgres" has no variable GHOST_SERVICE_NAME.',
        );
    });
});

describe("resolveReferences", () => {
    const targets = [postgres, redis];

    it("resolves every reference, whatever the casing or spacing", () => {
        const env = [
            "URL=" + ref(POSTGRES_ID, "DATABASE_URL"),
            "TWICE=" + ref(POSTGRES_ID, "POSTGRES_USER") + ":" + ref(POSTGRES_ID, "POSTGRES_USER"),
            "UPPER={{" + POSTGRES_ID.toUpperCase() + ".EMPTY}}",
            "HOST=" + ref(POSTGRES_ID, "DB_INTERNAL_HOST"),
            "CACHE=" + ref(REDIS_ID, "URL"),
        ].join("\n");

        expect(resolveReferences(env, targets)).toEqual({
            [`${POSTGRES_ID}.DATABASE_URL`]: "postgres://shop@aaaaaaaa-11111111-db.internal:5432",
            [`${POSTGRES_ID}.POSTGRES_USER`]: "shop",
            [`${POSTGRES_ID}.EMPTY`]: "",
            [`${POSTGRES_ID}.DB_INTERNAL_HOST`]: "aaaaaaaa-11111111-db.internal",
            [`${REDIS_ID}.URL`]: "redis://aaaaaaaa-66666666-cache.internal:6379",
        });
    });

    it("ignores commented-out references", () => {
        expect(resolveReferences("# A=" + ref(MISSING_ID, "NOPE") + "\n", targets)).toEqual({});
    });

    it("uses the domain it is given for the target", () => {
        expect(resolveReferences("A=" + ref(POSTGRES_ID, "APP_URL"), targets, "x.dev")).toEqual({
            [`${POSTGRES_ID}.APP_URL`]: "https://app.x.dev",
        });
    });

    it.each([
        ["{{ postgres.POSTGRES_USER }}", "Invalid variable reference {{ postgres.POSTGRES_USER }}"],
        ["{{ 1234.KEY }}", "Invalid variable reference {{ 1234.KEY }}"],
        [ref(MISSING_ID, "KEY"), "points to a resource that does not exist on this cluster"],
        [ref(POSTGRES_ID, "NOPE"), 'Resource "postgres" has no variable NOPE.'],
        [ref(POSTGRES_ID, "postgres_user"), 'Resource "postgres" has no variable postgres_user.'],
    ])("rejects %s", (value, message) => {
        expect(() => resolveReferences(`A=${value}`, targets)).toThrow(ComposeVariableError);
        expect(() => resolveReferences(`A=${value}`, targets)).toThrow(message);
    });

    it("rejects a resource referencing itself", () => {
        expect(() =>
            resolveReferences(
                "A=" + ref(POSTGRES_ID.toUpperCase(), "POSTGRES_USER"),
                targets,
                undefined,
                POSTGRES_ID,
            ),
        ).toThrow(
            `${ref(POSTGRES_ID.toUpperCase(), "POSTGRES_USER")} points at this resource itself. Use \${POSTGRES_USER} instead.`,
        );
    });

    it("resolves a reference to a reference, through the resource it points at", () => {
        expect(resolveReferences("A=" + ref(POSTGRES_ID, "UPSTREAM"), targets)).toEqual({
            [`${POSTGRES_ID}.UPSTREAM`]: "redis://aaaaaaaa-66666666-cache.internal:6379",
        });
        // postgres and redis reference each other, but BACK only needs postgres's plain user.
        expect(resolveReferences("A=" + ref(REDIS_ID, "BACK"), targets)).toEqual({
            [`${REDIS_ID}.BACK`]: "shop",
        });
    });

    it("rejects a value that leads back to itself instead of looping", () => {
        const loop = [
            target(POSTGRES_ID, "a", `X=${ref(REDIS_ID, "Y")}`, "services:\n  a:\n    image: a\n"),
            target(REDIS_ID, "b", `Y=${ref(POSTGRES_ID, "X")}`, "services:\n  b:\n    image: b\n"),
        ];

        expect(() => resolveReferences("A=" + ref(POSTGRES_ID, "X"), loop)).toThrow(
            "which references it in turn",
        );
    });

    it("rejects a broken reference even when a valid one comes first", () => {
        const env = "A=" + ref(POSTGRES_ID, "POSTGRES_USER") + "\nB=" + ref(POSTGRES_ID, "NOPE");

        expect(() => resolveReferences(env, targets)).toThrow("has no variable NOPE");
    });
});

describe("interpolateCompose with references", () => {
    const targets = [postgres, redis];

    const compose = (keys: string[]) =>
        `services:\n  api:\n    image: app\n    environment:\n${keys.map((key) => `      ${key}: \${${key}}`).join("\n")}\n`;

    const deploy = (env: string, keys: string[]) =>
        interpolateCompose(compose(keys), env, "p", undefined, resolveReferences(env, targets));

    it("substitutes referenced values into the consumer's env", () => {
        const out = deploy(
            "DATABASE_URL=" +
                ref(POSTGRES_ID, "DATABASE_URL") +
                "\nUSER=" +
                ref(POSTGRES_ID, "POSTGRES_USER"),
            ["DATABASE_URL", "USER"],
        );

        expect(out).toContain("DATABASE_URL: postgres://shop@aaaaaaaa-11111111-db.internal:5432");
        expect(out).toContain("USER: shop");
    });

    it("keeps `$` in referenced values literal for Uncloud", () => {
        const out = deploy(
            "PASSWORD=x-" +
                ref(POSTGRES_ID, "POSTGRES_PASSWORD") +
                "\nHOME_DIR=" +
                ref(POSTGRES_ID, "LITERAL"),
            ["PASSWORD", "HOME_DIR"],
        );

        expect(out).toContain("PASSWORD: x-pa$$word");
        expect(out).toContain("HOME_DIR: $$HOME");
    });

    it("keeps quotes and backticks in referenced values intact", () => {
        expect(deploy("M=" + ref(POSTGRES_ID, "MIXED"), ["M"])).toContain(`M: a"b'c\`d`);
    });

    it("lets consumer variables build on referenced ones in file order", () => {
        const env = "B_USER=" + ref(POSTGRES_ID, "POSTGRES_USER") + "\nA_DSN=${B_USER}@db\n";

        expect(deploy(env, ["A_DSN"])).toContain("A_DSN: shop@db");
    });

    it("works inside a default expression", () => {
        expect(deploy("X=${UNSET:-" + ref(POSTGRES_ID, "POSTGRES_USER") + "}", ["X"])).toContain(
            "X: shop",
        );
    });

    it("fails instead of deploying a reference it was not given", () => {
        const env = "A=" + ref(POSTGRES_ID, "POSTGRES_USER");

        expect(() => interpolateCompose(compose(["A"]), env, "p", undefined, {})).toThrow(
            "Unresolved variable reference",
        );
    });

    it("rejects references written in Compose but not in comments", () => {
        const reference = ref(POSTGRES_ID, "POSTGRES_USER");
        const service = "services:\n  api:\n    image: app\n";
        const commented = `# ${ref(POSTGRES_ID, "POSTGRES_USER")}\nservices:\n  api:\n    image: app\n`;
        const goTemplate = `services:\n  api:\n    image: app\n    command: ["--format", "{{ .Name }}"]\n`;

        for (const environment of [
            `    environment:\n      A: "${reference}"\n`,
            `    environment:\n      - A=${reference}\n`,
            `    command: echo x-${reference}\n`,
        ])
            expect(() => interpolateCompose(service + environment, "", "p")).toThrow(
                `Variable references only work in the resource's Variables, not in Compose: ${reference}`,
            );
        expect(() => assertNoComposeReference(commented)).not.toThrow();
        expect(() => assertNoComposeReference(goTemplate)).not.toThrow();
    });

    it("keeps reference text as-is when references are not requested", () => {
        const env = "A=" + ref(POSTGRES_ID, "POSTGRES_USER");

        expect(composeVariables("services: {}\n", env).A).toBe(ref(POSTGRES_ID, "POSTGRES_USER"));
    });
});

describe(".env evaluation order", () => {
    it("expands variables defined above, regardless of key sorting", () => {
        const env = "Z_FIRST=1\nA_SECOND=${Z_FIRST}-2\nexport M_THIRD = ${A_SECOND}-3\n";

        expect(composeVariables("services: {}\n", env)).toMatchObject({
            Z_FIRST: "1",
            A_SECOND: "1-2",
            M_THIRD: "1-2-3",
        });
    });

    it("leaves variables defined below unset, like Compose", () => {
        expect(composeVariables("services: {}\n", "A=${B}\nB=1\n").A).toBe("");
    });

    it("uses the last value of a repeated key", () => {
        expect(composeVariables("services: {}\n", "A=1\nA=2\n").A).toBe("2");
    });
});

describe("Compose files that must keep deploying", () => {
    const composeFiles = [
        ...globSync("templates/*/versions/*/compose.{yaml,yml}"),
        "internal/monitoring/compose.yaml",
    ];

    it("finds the bundled templates", () => {
        expect(composeFiles.length).toBeGreaterThan(10);
    });

    it.each(composeFiles)("%s has no false variable references", (file) => {
        expect(() => assertNoComposeReference(readFileSync(file, "utf8"))).not.toThrow();
    });

    it.each([
        'summary: "{{ $labels.instance }} is down"',
        'summary: "{{ $$labels.instance }} is down"',
        'summary: "{{ env.HOME }}"',
        'summary: "{{ .Values.name }}"',
        'summary: "{{ postgres.KEY }}"',
    ])("leaves templating like %s alone", (line) => {
        expect(() =>
            assertNoComposeReference(`services:\n  a:\n    labels:\n      ${line}\n`),
        ).not.toThrow();
    });
});

describe("system variables", () => {
    const identity = {
        projectId: PROJECT_ID,
        projectName: "Shop",
        resourceId: POSTGRES_ID,
        resourceName: "postgres",
    };

    const web = [
        "services:",
        "  web:",
        "    image: nginx",
        "    environment:",
        "      SELF: https://${WEB_PUBLIC_DOMAIN}",
        "    x-ports:",
        "      - shop.${STOAT_DOMAIN}:80/https",
        "  worker:",
        "    image: busybox",
        "",
    ].join("\n");

    it("adds Railway's project and resource variables when the identity is known", () => {
        expect(composeVariables(web, "", undefined, undefined, undefined, identity)).toMatchObject({
            STOAT_PROJECT_ID: PROJECT_ID,
            STOAT_PROJECT_NAME: "Shop",
            STOAT_RESOURCE_ID: POSTGRES_ID,
            STOAT_RESOURCE_NAME: "postgres",
        });
    });

    it("resolves public domains built from STOAT_DOMAIN, in Compose and in Variables", () => {
        const env = "LINK=${WEB_PUBLIC_DOMAIN}/login\n";

        expect(composeVariables(web, env, undefined, "example.com")).toMatchObject({
            WEB_PUBLIC_DOMAIN: "shop.example.com",
            LINK: "shop.example.com/login",
        });
        expect(composeVariables(web, env, undefined, "example.com")).not.toHaveProperty(
            "WORKER_PUBLIC_DOMAIN",
        );
        expect(interpolateCompose(web, env, undefined, "example.com")).toContain(
            "SELF: https://shop.example.com",
        );
    });

    it("only requires a public domain once it could have been resolved", () => {
        expect(
            composeVariables(web, "LINK=${WEB_PUBLIC_DOMAIN:?}\n", undefined, "example.com"),
        ).toMatchObject({ LINK: "shop.example.com" });
        expect(() =>
            composeVariables(web, "LINK=${WORKER_PUBLIC_DOMAIN:?}\n", undefined, "example.com"),
        ).toThrow(ComposeVariableError);
        expect(() => composeVariables("services: {}\n", "A=${MISSING:?}\n")).toThrow(
            ComposeVariableError,
        );
    });

    it("lets a same-named user variable override a built-in", () => {
        expect(
            composeVariables(
                web,
                "STOAT_RESOURCE_NAME=custom\n",
                undefined,
                undefined,
                undefined,
                identity,
            ),
        ).toMatchObject({ STOAT_RESOURCE_NAME: "custom" });
    });

    it("lists the same keys that references can read, plus Compose environment", () => {
        const shop = target(POSTGRES_ID, "postgres", "", web);

        const keys = composeSystemVariables(
            web,
            "",
            "aaaaaaaa-11111111",
            "example.com",
            identity,
        ).map((variable) => variable.key);

        expect(Object.keys(referenceVariables(shop, "example.com")).toSorted()).toEqual(
            [...keys, "SELF"].toSorted(),
        );
        expect(keys).toEqual(
            expect.arrayContaining([
                "STOAT_PROJECT_NAME",
                "STOAT_RESOURCE_ID",
                "WEB_INTERNAL_HOST",
                "WEB_PUBLIC_DOMAIN",
            ]),
        );
    });
});

describe("Compose environment references", () => {
    const worker = target(
        REDIS_ID,
        "worker",
        "API_KEY=secret\nSHARED=from-variables\nINDIRECT=" + ref(POSTGRES_ID, "POSTGRES_USER"),
        [
            "x-common: &common",
            "  COMMON: anchored",
            "services:",
            "  api:",
            "    image: api",
            "    environment:",
            "      <<: *common",
            "      WORKER_API_KEY: ${API_KEY}",
            "      SHARED: from-compose",
            "      PRICE: $$5",
            "      FROM_REFERENCE: ${INDIRECT}",
            "      UNSET: null",
            "  jobs:",
            "    image: jobs",
            "    environment:",
            "      - WORKER_API_KEY=second",
            "      - JOBS_URL=http://${API_INTERNAL_HOST}",
            "      - PASSTHROUGH",
        ].join("\n"),
    );

    it("resolves keys only Compose sets, expanded like a deploy", () => {
        expect(resolveReferences(`A=${ref(REDIS_ID, "WORKER_API_KEY")}`, [worker])).toEqual({
            [`${REDIS_ID}.WORKER_API_KEY`]: "secret",
        });
        expect(referenceVariables(worker)).toMatchObject({
            COMMON: "anchored",
            PRICE: "$5",
            JOBS_URL: "http://aaaaaaaa-66666666-api.internal",
        });
        expect(referenceVariables(worker)).not.toHaveProperty("UNSET");
        expect(referenceVariables(worker)).not.toHaveProperty("PASSTHROUGH");
    });

    it("lets Variables win a key Compose also sets", () => {
        expect(referenceVariables(worker).SHARED).toBe("from-variables");
    });

    it("resolves a Compose value built from a reference", () => {
        expect(
            resolveReferences(`A=${ref(REDIS_ID, "FROM_REFERENCE")}`, [worker, postgres]),
        ).toEqual({ [`${REDIS_ID}.FROM_REFERENCE`]: "shop" });
    });

    it("refuses a value that is a reference to a resource it can't reach", () => {
        expect(() => resolveReferences(`A=${ref(REDIS_ID, "FROM_REFERENCE")}`, [worker])).toThrow(
            "does not exist on this cluster",
        );
    });

    it("labels each key with where it comes from, draft keys included", () => {
        const keys = referenceKeys({
            ...worker,
            draftSpec:
                worker.spec + "\n  extra:\n    image: x\n    environment:\n      DRAFT_ONLY: yes",
        });

        const source = (key: string) => keys.find((entry) => entry.key === key)?.source;

        expect(source("API_KEY")).toBe("variables");
        expect(source("SHARED")).toBe("variables");
        expect(source("WORKER_API_KEY")).toBe("compose");
        expect(source("DRAFT_ONLY")).toBe("compose");
        expect(source("API_INTERNAL_HOST")).toBe("stoat");
    });

    it("still offers Variables when the Compose cannot be read", () => {
        expect(referenceKeys({ ...worker, spec: "services: [", draftSpec: "services: [" })).toEqual(
            [
                { key: "API_KEY", source: "variables" },
                { key: "INDIRECT", source: "variables" },
                { key: "SHARED", source: "variables" },
            ],
        );
    });
});
