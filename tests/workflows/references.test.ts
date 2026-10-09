import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
    assertNoComposeReference,
    ComposeVariableError,
    composeVariables,
    interpolateCompose,
} from "../../packages/workflows/src/compose";
import {
    referencedResourceIds,
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

function target(id: string, name: string, env: string, spec: string): ReferenceTarget {
    return { id, name, projectId: PROJECT_ID, projectName: "Shop", settings: { env }, spec };
}

const postgres = target(
    POSTGRES_ID,
    "postgres",
    [
        "POSTGRES_USER=shop",
        "POSTGRES_PASSWORD='pa$$word'",
        // Sorts before POSTGRES_USER: file order, not key order, decides what is defined.
        "DATABASE_URL=postgres://${POSTGRES_USER}@${DB_INTERNAL_HOST}:5432",
        "EMPTY=",
        "LITERAL='$$HOME'",
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
        [ref(POSTGRES_ID, "UPSTREAM"), '"postgres".UPSTREAM is itself a reference'],
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

    it("rejects reference cycles instead of looping", () => {
        expect(() => resolveReferences("A=" + ref(REDIS_ID, "BACK"), targets)).toThrow(
            "is itself a reference",
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
