import { describe, expect, it } from "vite-plus/test";
import {
    applyComposeSections,
    composeEnvironmentSections,
    setComposeEnvironment,
    splitRawEnvironment,
} from "../../apps/web/src/lib/components/canvas/panel/compose-environment";

const list = "services:\n  app:\n    environment:\n      - FOO=1 # keep\n      - BAR=2\n";

const map = 'services:\n  app:\n    environment:\n      FOO: "1"\n      BAR: 2\n';

describe("setComposeEnvironment", () => {
    it("edits a list entry in place, keeping its comment", () => {
        expect(setComposeEnvironment(list, "app", "FOO", "x")).toContain("- FOO=x # keep");
    });

    it("removes a list entry", () => {
        expect(setComposeEnvironment(list, "app", "BAR", undefined)).not.toContain("BAR");
    });

    it("edits a map entry, keeping its quotes", () => {
        expect(setComposeEnvironment(map, "app", "FOO", "x")).toContain('FOO: "x"');
    });

    it("removes a map entry", () => {
        expect(setComposeEnvironment(map, "app", "BAR", undefined)).not.toContain("BAR");
    });
});

describe("raw editor sections", () => {
    const services = new Set(["db", "metrics"]);

    const compose =
        "services:\n  db:\n    environment:\n      - USER=postgres\n      - PASS=a b\n  metrics:\n    environment:\n      URI: x\n";

    it("round-trips the Compose variables unchanged", () => {
        const sections = composeEnvironmentSections(compose);

        expect(sections).toBe('# [db]\nUSER=postgres\nPASS="a b"\n\n# [metrics]\nURI=x');

        const raw = splitRawEnvironment(`A=1\n\n${sections}\n`, services);

        expect(raw.env).toBe("A=1\n");
        expect(applyComposeSections(compose, raw.sections)).toBe(compose);
    });

    it("applies edits, additions and removals per service", () => {
        const { sections } = splitRawEnvironment(
            "# [db]\nUSER=root\nNEW=1\n# [metrics]\n",
            services,
        );

        const next = applyComposeSections(compose, sections);

        expect(next).toContain("- USER=root");
        expect(next).toContain("- NEW=1");
        expect(next).not.toContain("PASS");
        expect(next).not.toContain("URI");
    });

    it("treats text without headers as the whole .env", () => {
        expect(splitRawEnvironment("A=1\n", services).env).toBe("A=1\n");
    });

    it("keeps .env comments shaped like headers, and multi-line values, as Variables", () => {
        const text =
            '# [secrets]\nTOKEN=abc\nKEY="line one\n# [db]\nline three"\n\n# [db]\nUSER=root\n';

        const { env, sections } = splitRawEnvironment(text, services);

        expect(env).toBe('# [secrets]\nTOKEN=abc\nKEY="line one\n# [db]\nline three"\n');
        expect([...sections.keys()]).toEqual(["db"]);
    });

    it("refuses an unknown or repeated section instead of dropping its variables", () => {
        expect(() => splitRawEnvironment("# [db]\nA=1\n# [secrets]\nB=2\n", services)).toThrow(
            "names no Compose service",
        );
        expect(() => splitRawEnvironment("# [db]\nA=1\n# [db]\nB=2\n", services)).toThrow(
            "appears twice",
        );
    });
});
