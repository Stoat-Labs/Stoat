import { describe, expect, it } from "vite-plus/test";
import {
    referenceSpans,
    typedTrigger,
} from "../../apps/web/src/lib/components/variables/env-references";
import {
    referenceGroups,
    type ReferenceTarget,
} from "../../apps/web/src/lib/components/variables/reference-options";

const PROJECT = "aaaaaaaa-0000-4000-8000-000000000001";

const OTHER_PROJECT = "aaaaaaaa-0000-4000-8000-000000000002";

const THIRD_PROJECT = "aaaaaaaa-0000-4000-8000-000000000003";

const POSTGRES = "1111abcd-2222-4333-8444-55555555eeee";

const target = (
    id: string,
    name: string,
    projectId: string,
    projectName: string,
    keys: string[] = [],
): ReferenceTarget => ({ id, name, projectId, projectName, keys });

// Server order: by project name, then creation.
const targets = [
    target("b0000000-0000-4000-8000-000000000001", "clickhouse", OTHER_PROJECT, "Analytics", [
        "CH_PASSWORD",
    ]),
    target(POSTGRES, "postgres", PROJECT, "Shop", ["DB_INTERNAL_HOST", "POSTGRES_USER"]),
    target("b0000000-0000-4000-8000-000000000003", "redis", PROJECT, "Shop", ["URL"]),
    target("b0000000-0000-4000-8000-000000000004", "worker", THIRD_PROJECT, "Zebra", []),
];

describe("referenceGroups", () => {
    it("lists this project's resources first, then other projects in server order", () => {
        expect(
            referenceGroups(targets, PROJECT).map((group) => [
                group.label,
                group.items.map((item) => item.search),
            ]),
        ).toEqual([
            ["This project", ["postgres", "redis"]],
            ["Analytics", ["clickhouse"]],
            ["Zebra", ["worker"]],
        ]);
    });

    it("offers resources, not variables, in step one", () => {
        for (const group of referenceGroups(targets, PROJECT))
            for (const item of group.items) expect(item.key).toBeUndefined();
    });

    it("omits the This project group when it has nothing to offer", () => {
        expect(referenceGroups(targets, THIRD_PROJECT).map((group) => group.label)).toEqual([
            "This project",
            "Analytics",
            "Shop",
        ]);
        expect(
            referenceGroups(targets, "aaaaaaaa-0000-4000-8000-00000000000f").map(
                (group) => group.label,
            ),
        ).toEqual(["Analytics", "Shop", "Zebra"]);
        expect(referenceGroups([], PROJECT)).toEqual([]);
    });

    it("lists only the selected resource's variables in step two", () => {
        const postgres = targets[1]!;

        expect(referenceGroups(targets, PROJECT, postgres)).toEqual([
            {
                label: "postgres",
                items: [
                    { target: postgres, key: "DB_INTERNAL_HOST", search: "DB_INTERNAL_HOST" },
                    { target: postgres, key: "POSTGRES_USER", search: "POSTGRES_USER" },
                ],
            },
        ]);
    });

    it("returns an empty group for a resource without variables", () => {
        expect(referenceGroups(targets, PROJECT, targets[3])).toEqual([
            { label: "worker", items: [] },
        ]);
    });

    it("keeps same-named projects apart", () => {
        const twins = [
            target("c0000000-0000-4000-8000-000000000001", "a", OTHER_PROJECT, "Twin"),
            target("c0000000-0000-4000-8000-000000000002", "b", THIRD_PROJECT, "Twin"),
        ];

        expect(referenceGroups(twins, PROJECT)).toHaveLength(2);
    });
});

describe("referenceSpans", () => {
    const names = new Map([[POSTGRES, "postgres"]]);

    it("locates the id inside each reference and names known resources", () => {
        const text = `A={{ ${POSTGRES}.POSTGRES_USER }}\nB={{${POSTGRES.toUpperCase()}.URL}}\n`;
        const spans = referenceSpans(text, names);

        expect(spans).toEqual([
            { from: 5, to: 41, name: "postgres" },
            { from: text.lastIndexOf("{{") + 2, to: text.lastIndexOf("{{") + 38, name: "postgres" },
        ]);
        expect(text.slice(spans[0]!.from, spans[0]!.to)).toBe(POSTGRES);
    });

    it("leaves unknown or malformed resources unnamed so they get flagged", () => {
        const text = "A={{ 99999999-2222-4333-8444-555555555555.X }}\nB={{ postgres.X }}\n";

        expect(
            referenceSpans(text, names).map((span) => [text.slice(span.from, span.to), span.name]),
        ).toEqual([
            ["99999999-2222-4333-8444-555555555555", undefined],
            ["postgres", undefined],
        ]);
    });

    it("ignores template placeholders and Go templates", () => {
        expect(referenceSpans("A={{ UUID }}\nB={{ .Name }}\nC={{ 32 }}\n", names)).toEqual([]);
    });
});

describe("typedTrigger", () => {
    it("fires right after `{{`", () => {
        expect(typedTrigger("A={{", 4)).toEqual([2, 4]);
        expect(typedTrigger("{{", 2)).toEqual([0, 2]);
        expect(typedTrigger("={{", 120)).toEqual([118, 120]);
    });

    it.each([
        ["a single brace", "A={"],
        ["a triple brace", "{{{"],
        ["nothing typed", ""],
        ["text after the braces", "{{x"],
        ["closing braces", "A=}}"],
    ])("stays quiet after %s", (_, before) => {
        expect(typedTrigger(before, before.length)).toBeUndefined();
    });
});
