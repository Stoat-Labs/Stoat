import { describe, expect, it } from "vite-plus/test";
import { listPageSize, pageParser } from "../../apps/web/src/lib/params/query-params";

describe("page query parameter", () => {
    it("restores positive pages and serializes them", () => {
        expect(pageParser.defaultValue).toBe(1);

        for (const page of [1, 2, 42, 1000]) {
            expect(pageParser.parse(pageParser.serialize(page))).toBe(page);
        }

        expect(pageParser.parse("003")).toBe(3);
        expect((pageParser.parse("3")! - 1) * listPageSize).toBe(50);
    });

    it.each([
        "",
        "0",
        "-1",
        "1.5",
        "3junk",
        "1e2",
        " 2",
        "Infinity",
        "NaN",
        "9007199254740991",
        "9007199254740992",
    ])("rejects invalid or unsafe page %j", (value) => {
        expect(pageParser.parse(value)).toBeNull();
    });
});
