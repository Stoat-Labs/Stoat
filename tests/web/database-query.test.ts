import { describe, expect, it } from "vite-plus/test";
import {
    parsePage,
    whereClause,
} from "../../apps/web/src/lib/components/canvas/panel/database/query";

describe("database studio queries", () => {
    it("quotes filter columns and values", () => {
        expect(
            whereClause([
                { column: 'we"ird', operator: "equals", value: "it's" },
                { column: "note", operator: "contains", value: "50%_off" },
                { column: "deleted_at", operator: "null", value: "" },
            ]),
        ).toBe(
            `WHERE "we""ird" = 'it''s' AND "note"::text ILIKE '%50\\%\\_off%' AND "deleted_at" IS NULL`,
        );
        expect(whereClause([])).toBe("");
    });

    it("reads a page's columns and values as text", () => {
        expect(
            parsePage(
                JSON.stringify({
                    columns: [["id", "integer", true, null, true]],
                    rows: [["9223372036854775807", null, "a"]],
                }),
            ),
        ).toEqual({
            columns: [
                { name: "id", type: "integer", nullable: false, defaultValue: null, primary: true },
            ],
            rows: [["9223372036854775807", null, "a"]],
        });
    });
});
