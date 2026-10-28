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
    keys: ReferenceTarget["keys"] = [],
): ReferenceTarget => ({ id, name, projectId, projectName, keys });

// Server order: by project name, then creation.
const targets = [
    target("b0000000-0000-4000-8000-000000000001", "clickhouse", OTHER_PROJECT, "Analytics", [
        { key: "CH_PASSWORD", source: "variables" },
    ]),
    target(POSTGRES, "postgres", PROJECT, "Shop", [
        { key: "DB_INTERNAL_HOST", source: "stoat" },
        { key: "POSTGRES_USER", source: "variables" },
        { key: "WORKER_KEY", source: "compose" },
    ]),
    target("b0000000-0000-4000-8000-000000000003", "redis", PROJECT, "Shop", [
        { key: "URL", source: "variables" },
    ]),
    target("b0000000-0000-4000-8000-000000000004", "worker", THIRD_PROJECT, "Zebra", []),
];

const labels = (groups: ReturnType<typeof referenceGroups>) =>
    groups.map((group) => [group.label, group.items.map((item) => item.label)]);

describe("referenceGroups", () => {
    it("lists the current project first, then the rest in server order", () => {
        expect(labels(referenceGroups(targets, { level: "projects" }, PROJECT))).toEqual([
            ["Projects", ["Shop (this project)", "Analytics", "Zebra"]],
        ]);
        expect(
            referenceGroups(targets, { level: "projects" }, PROJECT)[0]?.items.map(
                (item) => item.hint,
            ),
        ).toEqual(["2 resources", "1 resource", "1 resource"]);
    });

    it("leaves out a current project with nothing to reference", () => {
        expect(
            labels(
                referenceGroups(
                    targets,
                    { level: "projects" },
                    "aaaaaaaa-0000-4000-8000-00000000000f",
                ),
            ),
        ).toEqual([["Projects", ["Analytics", "Shop", "Zebra"]]]);
    });

    it("lists one project's resources, each opening its variables", () => {
        const [group] = referenceGroups(
            targets,
            { level: "resources", projectId: PROJECT },
            PROJECT,
        );

        expect(group?.label).toBe("Shop");
        expect(group?.items.map((item) => [item.label, item.hint])).toEqual([
            ["postgres", "3 variables"],
            ["redis", "1 variable"],
        ]);
        expect(group?.items[0]?.next).toEqual({
            level: "variables",
            projectId: PROJECT,
            target: targets[1],
        });
        expect(
            referenceGroups(targets, { level: "resources", projectId: OTHER_PROJECT }, PROJECT)[0]
                ?.label,
        ).toBe("Analytics");
    });

    it("groups a resource's variables by where they come from", () => {
        const postgres = targets[1]!;

        const groups = referenceGroups(
            targets,
            { level: "variables", projectId: PROJECT, target: postgres },
            PROJECT,
        );

        expect(labels(groups)).toEqual([
            ["Variables", ["POSTGRES_USER"]],
            ["Set in Compose", ["WORKER_KEY"]],
            ["Added by Stoat", ["DB_INTERNAL_HOST"]],
        ]);
        expect(groups[0]?.items[0]).toEqual({
            id: "POSTGRES_USER",
            label: "POSTGRES_USER",
            key: "POSTGRES_USER",
            target: postgres,
        });
    });

    it("has no groups for a resource without variables", () => {
        expect(
            referenceGroups(
                targets,
                { level: "variables", projectId: THIRD_PROJECT, target: targets[3]! },
                PROJECT,
            ),
        ).toEqual([]);
    });

    it("keeps same-named projects apart", () => {
        const twins = [
            target("c0000000-0000-4000-8000-000000000001", "a", OTHER_PROJECT, "Twin"),
            target("c0000000-0000-4000-8000-000000000002", "b", THIRD_PROJECT, "Twin"),
        ];

        expect(referenceGroups(twins, { level: "projects" }, PROJECT)[0]?.items).toHaveLength(2);
    });
});

describe("referenceSpans", () => {
    const names = new Map([[POSTGRES, "postgres"]]);

    it("covers each whole reference and names known resources", () => {
        const text = `A={{ ${POSTGRES}.POSTGRES_USER }}\nB={{${POSTGRES.toUpperCase()}.URL}}\n`;
        const spans = referenceSpans(text, names);

        expect(spans.map((span) => [text.slice(span.from, span.to), span.name, span.key])).toEqual([
            [`{{ ${POSTGRES}.POSTGRES_USER }}`, "postgres", "POSTGRES_USER"],
            [`{{${POSTGRES.toUpperCase()}.URL}}`, "postgres", "URL"],
        ]);
    });

    it("leaves unknown or malformed resources unnamed so they get flagged", () => {
        const text = "A={{ 99999999-2222-4333-8444-555555555555.X }}\nB={{ postgres.X }}\n";

        expect(
            referenceSpans(text, names).map((span) => [text.slice(span.from, span.to), span.name]),
        ).toEqual([
            ["{{ 99999999-2222-4333-8444-555555555555.X }}", undefined],
            ["{{ postgres.X }}", undefined],
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
