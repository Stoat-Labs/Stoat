import { describe, expect, it } from "vite-plus/test";
import { safeNextPath } from "../../apps/web/src/lib/params/safe-next";

const origin = "https://stoat.example";

describe("safeNextPath", () => {
    it("keeps same-site paths with their query", () => {
        expect(safeNextPath("/?dialog=create-project", origin)).toBe("/?dialog=create-project");
        expect(safeNextPath("/projects/1#x", origin)).toBe("/projects/1#x");
    });

    it.each([null, "", "https://evil.com", "//evil.com", "/\\evil.com", "/..//evil.com"])(
        "falls back to / for %j",
        (value) => {
            expect(safeNextPath(value, origin)).toBe("/");
        },
    );
});
