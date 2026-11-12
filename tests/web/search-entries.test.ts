import { expect, it } from "vite-plus/test";
import { searchGroups } from "../../apps/web/src/lib/components/search/search-entries";

const projects = [
    {
        id: "shop",
        name: "Shop",
        clusterName: "Production",
        resources: [{ id: "api", name: "API", icon: null, type: "compose" }],
    },
    { id: "empty", name: "Empty", clusterName: "Staging", resources: [] },
];

it("lists every project and resource, linking to the canvas", () => {
    expect(searchGroups(projects)).toEqual([
        {
            label: "Projects",
            items: [
                expect.objectContaining({ label: "Shop", href: "/projects/shop/canvas" }),
                expect.objectContaining({ label: "Empty", hint: "Staging" }),
            ],
        },
        {
            label: "Resources",
            items: [
                expect.objectContaining({
                    label: "API",
                    hint: "Shop",
                    href: "/projects/shop/canvas?node=api",
                }),
            ],
        },
    ]);
});

it("offers adding to the current project first", () => {
    expect(searchGroups(projects, "shop")[0]).toEqual({
        label: "Shop",
        items: [expect.objectContaining({ kind: "add", href: "/projects/shop/canvas?add=root" })],
    });
});

it("drops groups with nothing in them", () => {
    expect(searchGroups([])).toEqual([]);
});
