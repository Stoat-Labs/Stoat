import { parseEnv } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { composeEnvironment } from "../../apps/web/src/lib/components/canvas/panel/compose-environment";
import {
    formatEnvValue,
    parseEnvLines,
    removeEnvVariable,
    setEnvVariable,
} from "../../packages/workflows/src/env-lines";

const sample = [
    "# Database",
    "export DB_HOST=db # primary",
    'DB_PASS="s3cret #1"',
    "",
    'MULTI="line one',
    'line two"',
    "REF={{ 5d351c11-af82-4d21-bd1d-23306348db08.TOKEN }}",
    "DB_HOST=override",
    "",
].join("\n");

describe("parseEnvLines", () => {
    it("reads values the way Node's parseEnv does", () => {
        const rows = Object.fromEntries(parseEnvLines(sample).map((row) => [row.key, row.value]));

        expect(rows).toEqual(parseEnv(sample));
    });

    it.each(["K=abc#comment", 'K="unclosed', "K='a\nb'\nB=1"])(
        "matches parseEnv for %j",
        (text) => {
            const rows = Object.fromEntries(parseEnvLines(text).map((row) => [row.key, row.value]));

            expect(rows).toEqual(parseEnv(text));
        },
    );
});

describe("setEnvVariable", () => {
    it("changes only the edited assignment", () => {
        const next = setEnvVariable(sample, "DB_PASS", "new value");

        expect(next).toBe(sample.replace('DB_PASS="s3cret #1"', 'DB_PASS="new value"'));
    });

    it("keeps single quotes so `$` stays literal", () => {
        expect(setEnvVariable("PASS='a$n'\n", "PASS", "b$n")).toBe("PASS='b$n'\n");
        expect(setEnvVariable("PASS='a$n'\n", "PASS", "it's")).toBe('PASS="it\'s"\n');
    });

    it("appends a new variable with a trailing newline", () => {
        expect(setEnvVariable("A=1", "B", "2")).toBe("A=1\nB=2\n");
    });

    it("replaces a multiline value and keeps the lines around it", () => {
        const next = setEnvVariable(sample, "MULTI", "single");

        expect(next.split("\n")).toContain("MULTI=single");
        expect(next).toContain("# Database");
        expect(parseEnv(next).REF).toBe(parseEnv(sample).REF);
    });

    it("renames without leaving duplicates behind", () => {
        const next = setEnvVariable(sample, "HOST", "x", "DB_HOST");

        expect(parseEnv(next).DB_HOST).toBeUndefined();
        expect(parseEnv(next).HOST).toBe("x");
    });
});

describe("removeEnvVariable", () => {
    it("drops every assignment of the key and nothing else", () => {
        const next = removeEnvVariable(sample, "DB_HOST");

        expect(parseEnv(next).DB_HOST).toBeUndefined();
        expect(next).toContain("# Database");
        expect(parseEnv(next).DB_PASS).toBe("s3cret #1");
    });
});

describe("formatEnvValue", () => {
    it.each(["plain", "with space", 'say "hi"', "a#b", "two\nlines", 'it\'s "both"'])(
        "round-trips %j",
        (value) => {
            expect(parseEnv(`K=${formatEnvValue(value)}`).K).toBe(value);
        },
    );

    it.each(["a\"b'c`d", "a\\nb'c`d"])("rejects %j, which no quoting keeps", (value) => {
        expect(() => formatEnvValue(value)).toThrow();
    });
});

describe("composeEnvironment", () => {
    it("reads list and map environments per service, skipping pass-through keys", () => {
        const compose = [
            "services:",
            "  db:",
            "    environment:",
            "      - TZ=Europe/Bucharest",
            "      - URL=a=b",
            "      - PASSTHROUGH",
            "  app:",
            "    environment:",
            "      PORT: 3000",
            "      EMPTY:",
            "  bare:",
            "    image: nginx",
        ].join("\n");

        expect(composeEnvironment(compose)).toEqual([
            { service: "db", key: "TZ", value: "Europe/Bucharest" },
            { service: "db", key: "URL", value: "a=b" },
            { service: "app", key: "PORT", value: "3000" },
        ]);
    });

    it("returns nothing for an unparsable draft", () => {
        expect(composeEnvironment("services: [")).toEqual([]);
    });
});
