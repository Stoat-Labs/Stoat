import { describe, expect, it } from "vite-plus/test";
import { setComposeEnvironment } from "../../apps/web/src/lib/components/canvas/panel/compose-environment";

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
