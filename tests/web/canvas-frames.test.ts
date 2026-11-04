import { describe, expect, it } from "vite-plus/test";

import {
    buildCanvas,
    buildEdges,
    cardTrays,
    moveResourceCards,
    foldExporters,
    frameContainers,
    frameRect,
    freeSlot,
    gridDots,
    landResourceCards,
    refitFrames,
    repairOverlaps,
    settle,
    type CanvasService,
} from "../../apps/web/src/lib/components/canvas/graph";

describe("gridDots", () => {
    it("puts dots mid-cell, on whole pixels", () => {
        expect(gridDots(0, 24, 100)).toEqual([12, 36, 60, 84]);
        expect(gridDots(0, 22.32, 60)).toEqual([11, 33, 56]);
    });

    it("follows a pan in either direction", () => {
        expect(gridDots(30, 24, 50)).toEqual([18, 42]);
        expect(gridDots(-30, 24, 50)).toEqual([-18, 6, 30]);
    });
});

describe("frameRect", () => {
    it("wraps its cards like Railway: 24px on the sides and bottom, 48px on top", () => {
        expect(
            frameRect([
                { x: 100, y: 200, width: 288, height: 144 },
                { x: 500, y: 400, width: 288, height: 192 },
            ]),
        ).toEqual({ x: 76, y: 152, width: 736, height: 464 });
    });
});

describe("refitFrames", () => {
    it("follows a card dragged past the frame edge, instead of dropping it", () => {
        // SAFETY: the canvas only reads `frameId` while refitting.
        const card = (id: string, x: number, y: number) =>
            ({
                id,
                type: "card",
                position: { x, y },
                width: 288,
                height: 144,
                data: { frameId: "r" },
            }) as never;

        const nodes = refitFrames([
            // SAFETY: as above; the frame's own data is passed through untouched.
            {
                id: "r",
                type: "stack",
                position: { x: 0, y: 0 },
                width: 1,
                height: 1,
                data: {},
            } as never,
            card("a", 24, 48),
            card("b", 1000, 900),
        ]);

        expect(nodes[0]).toMatchObject({
            position: { x: 0, y: 0 },
            width: 1312,
            height: 1068,
        });
    });
});

describe("freeSlot", () => {
    const member = { x: 0, y: 48, width: 288, height: 144 };

    it("keeps the drop spot when it covers nothing", () => {
        expect(freeSlot({ x: 400, y: 48, width: 288, height: 144 }, [member])).toEqual({
            x: 400,
            y: 48,
        });
    });

    it("drops into the next row under the frame's cards instead of covering one", () => {
        expect(freeSlot({ x: 100, y: 100, width: 288, height: 144 }, [member])).toEqual({
            x: 0,
            y: 216,
        });
    });
});

describe("repairOverlaps", () => {
    // SAFETY: repairOverlaps only reads ids, types, positions, sizes and `frameId`.
    const card = (id: string, x: number, y: number, frameId?: string) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { frameId },
        }) as never;

    it("moves an overlapping card below the one above it, on the grid", () => {
        expect(repairOverlaps([card("a", 0, 0), card("b", 100, 48)])).toEqual({
            a: { x: 0, y: 0 },
            b: { x: 100, y: 168 },
        });
    });

    it("moves a whole frame together with its cards", () => {
        // SAFETY: as above; the frame contributes only its rectangle.
        const frame = {
            id: "stack",
            type: "stack",
            position: { x: 0, y: 96 },
            width: 336,
            height: 216,
            data: {},
        } as never;

        const moved = repairOverlaps([card("a", 0, 0), frame, card("x", 24, 144, "stack")]);

        expect(moved.x).toEqual({ x: 24, y: 216 });
    });
});

describe("settle", () => {
    // SAFETY: settle only reads ids, types, positions, sizes, `hidden` and `frameId`.
    const card = (id: string, x: number, y: number, frameId?: string) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { frameId },
        }) as never;

    it("leaves a card that covers nothing where it was dropped", () => {
        expect(settle([card("a", 0, 0), card("b", 600, 0)], "b")).toEqual({
            b: { x: 600, y: 0 },
        });
    });

    it("lets a card partly overlap another", () => {
        expect(settle([card("a", 0, 0), card("b", 144, 72)], "b")).toEqual({
            b: { x: 144, y: 72 },
        });
    });

    it("cascades a card dropped right on top of another one grid step down-right", () => {
        expect(settle([card("a", 0, 0), card("b", 10, -5)], "b")).toEqual({
            b: { x: 24, y: 24 },
        });
    });

    it("shifts a card that hides another's left edge, keeping its own vertical offset", () => {
        expect(settle([card("a", 0, 0), card("b", 0, 48)], "b")).toEqual({
            b: { x: 24, y: 48 },
        });
    });

    it("keeps cascading past a card already cascaded there", () => {
        expect(settle([card("a", 0, 0), card("b", 24, 24), card("c", 0, 0)], "c")).toEqual({
            c: { x: 48, y: 48 },
        });
    });

    it("keeps a card inside a frame off its siblings", () => {
        const moved = settle([card("a", 0, 48, "s"), card("b", 0, 48, "s")], "b");

        expect(moved.b).toEqual({ x: 24, y: 72 });
    });
});

describe("buildCanvas", () => {
    const service = (
        name: string,
        volumes: string[] = [],
        configs: string[] = [],
    ): CanvasService => ({
        name,
        image: undefined,
        template: undefined,
        dependsOn: [],
        volumes,
        configs,
        isNew: false,
        domains: [],
        internalHostname: null,
    });

    // SAFETY: the layout only reads `id`, `name`, `projectId`, `icon`, `engine` and `groupId` of a resource.
    const resource = (id: string, groupId: string | null = null) =>
        ({ id, name: id, projectId: "p", icon: null, engine: null, groupId }) as never;

    // SAFETY: the layout only reads these fields of a graph entry.
    const entry = (id: string, references: string[] = [], services = [service("app")]) =>
        ({
            id,
            draftOnly: false,
            parseError: false,
            references,
            volumes: [],
            configs: [],
            services,
        }) as never;

    const group = (id: string) => ({ id, projectId: "p", name: id, icon: null });

    it("frames a resource's services outside a group, each service its own card with its trays", () => {
        const { nodes } = buildCanvas(
            [resource("sure")],
            [
                entry(
                    "sure",
                    [],
                    [service("web", ["storage"]), service("redis", ["cache"], ["redis.conf"])],
                ),
            ],
            [],
            {},
            {},
        );

        expect(nodes.map((node) => [node.id, node.type])).toEqual([
            ["sure", "stack"],
            ["sure:web", "card"],
            ["sure:redis", "card"],
        ]);
        expect(nodes.slice(1).map((node) => node.height)).toEqual([144 + 48, 144 + 2 * 48]);
        expect(nodes[0]?.data).toMatchObject({ group: undefined, name: "sure" });
        expect(nodes[1]?.data).toMatchObject({ shared: true, groupId: undefined, frameId: "sure" });
    });

    it("keeps a database and its metrics exporter on one card, without a frame", () => {
        const { nodes } = buildCanvas(
            [resource("pg")],
            [
                entry(
                    "pg",
                    [],
                    [
                        { ...service("postgres"), image: "postgres:18-alpine" },
                        {
                            ...service("postgres-metrics"),
                            image: "prometheuscommunity/postgres-exporter:v0.20.1",
                        },
                    ],
                ),
            ],
            [],
            {},
            {},
        );

        expect(nodes.map((node) => [node.id, node.type])).toEqual([["pg", "card"]]);
    });

    it("puts every service card of a grouped resource in the group's frame", () => {
        const { nodes } = buildCanvas(
            [resource("forgejo", "g"), resource("other")],
            [entry("forgejo", [], [service("forgejo"), service("forgejo-db")]), entry("other")],
            [group("g")],
            {},
            {},
        );

        expect(
            nodes.flatMap((node) =>
                node.type === "card" && node.data.groupId === "g" ? [node.id] : [],
            ),
        ).toEqual(["forgejo:forgejo", "forgejo:forgejo-db"]);
        expect(nodes.filter((node) => node.type === "stack").map((node) => node.id)).toEqual(["g"]);
    });

    it("keeps the spot a lone service had in its resource's old frame", () => {
        const { nodes } = buildCanvas(
            [resource("sure")],
            [entry("sure", [], [service("web")])],
            [],
            {},
            { "sure:web": { x: 480, y: 600 } },
        );

        expect(nodes[0]?.position).toEqual({ x: 480, y: 600 });
    });

    it("lays a resource's services out from where its single card was saved", () => {
        const { nodes } = buildCanvas(
            [resource("sure")],
            [entry("sure", [], [service("web"), service("db")])],
            [],
            {},
            { sure: { x: 480, y: 600 } },
        );

        expect(nodes.slice(1).map((node) => node.position)).toEqual([
            { x: 480, y: 600 },
            { x: 480, y: 600 + 144 + 24 },
        ]);
    });

    it("draws depends_on between service cards and references from a resource's first card", () => {
        const web = { ...service("web"), dependsOn: ["db"] };

        const { edges } = buildCanvas(
            [resource("app"), resource("pg")],
            [entry("app", ["pg"], [web, service("db")]), entry("pg")],
            [],
            {},
            {},
        );

        expect(edges.map((edge) => edge.id)).toEqual([
            "reference:app:web:pg",
            "depends:app:web:app:db",
        ]);
    });
    it("frames the resources of one group together and leaves the rest alone", () => {
        const { nodes } = buildCanvas(
            [resource("a", "g"), resource("b"), resource("c", "g")],
            [entry("a"), entry("b"), entry("c")],
            [group("g")],
            {},
            {},
        );

        const frame = nodes.find((node) => node.type === "stack");
        const members = nodes.filter((node) => node.type === "card" && node.data.groupId === "g");

        expect(frame?.id).toBe("g");
        expect(members.map((node) => node.id)).toEqual(["a", "c"]);
        expect(nodes.find((node) => node.id === "b")?.data).toMatchObject({ groupId: undefined });
        expect({ ...frame?.position, width: frame?.width, height: frame?.height }).toEqual(
            frameRect(members.map((node) => ({ ...node.position, width: 288, height: 144 }))),
        );
    });

    it("draws no frame for a group nothing is in, and none for an unknown one", () => {
        const { nodes } = buildCanvas(
            [resource("a", "gone")],
            [entry("a")],
            [group("empty")],
            {},
            {},
        );

        expect(nodes.map((node) => [node.id, node.type])).toEqual([["a", "card"]]);
        expect(Number.isFinite(nodes[0]?.position.x)).toBe(true);
    });

    it("hands a collapsed group's references to its frame, once, and drops those inside it", () => {
        const { edges } = buildCanvas(
            [resource("a", "g"), resource("b", "g"), resource("c")],
            [entry("a", ["b", "c"]), entry("b", ["c"]), entry("c")],
            [group("g")],
            {},
            {},
            new Set(["g"]),
        );

        expect(edges.map((edge) => edge.id)).toEqual(["reference:g:c"]);
    });
});

describe("moveResourceCards", () => {
    // SAFETY: the helper only reads ids, types, positions and `resource.id`.
    const card = (id: string, resource: string, x: number, y: number) =>
        ({ id, type: "card", position: { x, y }, data: { resource: { id: resource } } }) as never;

    it("takes a resource's own volume and config cards along, keeping their offset", () => {
        expect(
            moveResourceCards(
                [
                    card("r", "r", 0, 0),
                    card("r/data", "r", 0, 192),
                    card("r#app.conf", "r", 312, 0),
                    card("other", "other", 600, 600),
                ],
                "r",
                { x: 0, y: 0 },
                { x: 1000, y: 48 },
            ),
        ).toEqual({
            r: { x: 1000, y: 48 },
            "r/data": { x: 1000, y: 240 },
            "r#app.conf": { x: 1312, y: 48 },
        });
    });

    it("lands a dragged service card where it was dropped and takes its siblings along", () => {
        expect(
            moveResourceCards(
                [card("r:web", "r", 1000, 48), card("r:db", "r", 0, 192)],
                "r:web",
                { x: 0, y: 0 },
                { x: 1000, y: 48 },
            ),
        ).toEqual({
            "r:web": { x: 1000, y: 48 },
            "r:db": { x: 1000, y: 240 },
        });
    });
});

describe("landResourceCards", () => {
    // SAFETY: the helper only reads ids, types, sizes, positions and `resource.id`.
    const card = (id: string, x: number, y: number) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { resource: { id: "r" } },
        }) as never;

    const member = { x: 0, y: 48, width: 288, height: 144 };
    const from = { x: 0, y: 0 };

    it("keeps the drop when none of the moving cards covers a member", () => {
        expect(
            landResourceCards(
                [card("r:web", 400, 48), card("r:db", 0, 192)],
                "r:web",
                from,
                { x: 400, y: 48 },
                [member],
            ),
        ).toEqual({ "r:web": { x: 400, y: 48 }, "r:db": { x: 400, y: 240 } });
    });

    it("moves every card to the next free row when only a sibling covers a member", () => {
        expect(
            landResourceCards(
                [card("r:web", 400, 48), card("r:db", -400, 0)],
                "r:web",
                from,
                { x: 400, y: 48 },
                [member],
            ),
        ).toEqual({ "r:web": { x: 400, y: 216 }, "r:db": { x: 0, y: 216 } });
    });
});

describe("frameContainers", () => {
    const up = { service: "web" };
    const down = { service: "worker" };

    const cards = [
        { id: "r:web", resourceId: "r", name: "web", icon: null },
        { id: "r:worker", resourceId: "r", name: "worker", icon: null },
    ];

    // SAFETY: only `group` and `resources` are read.
    const frame = (group: { id: string } | undefined) => ({ group, resources: cards }) as never;

    it("checks each service of a resource's own frame separately", () => {
        expect(frameContainers(frame(undefined), { r: [up] })).toEqual([[up], []]);
        expect(frameContainers(frame(undefined), { r: [up, down] })).toEqual([[up], [down]]);
    });

    it("counts a group's resource once, however many cards it shows", () => {
        expect(frameContainers(frame({ id: "g" }), { r: [up, down] })).toEqual([[up, down]]);
    });
});

describe("exporter trays and edges", () => {
    const service = (name: string, image?: string): CanvasService => ({
        name,
        image,
        template: undefined,
        dependsOn: [],
        volumes: [],
        configs: [],
        isNew: false,
        domains: [],
        internalHostname: null,
    });

    // SAFETY: the layout only reads `id`, `name`, `projectId`, `icon`, `engine` and `groupId` of a resource.
    const resource = (id: string) =>
        ({ id, name: id, projectId: "p", icon: null, engine: null, groupId: null }) as never;

    // SAFETY: the layout only reads these fields of a graph entry.
    const entry = (id: string, references: string[], services: CanvasService[]) =>
        ({
            id,
            draftOnly: false,
            parseError: false,
            references,
            volumes: [],
            configs: [],
            services,
        }) as never;

    it("shows one tray for exporters sharing a name", () => {
        expect(cardTrays({ ...service("db"), exporters: ["metrics", "metrics"] })).toEqual([
            { kind: "metrics", name: "metrics" },
        ]);
    });

    it("keeps references to a database with an exporter when rebuilt from the unfolded graph", () => {
        const graph = [
            entry("app", ["db"], [service("web", "nginx")]),
            entry(
                "db",
                [],
                [
                    service("server", "postgres:18-alpine"),
                    service("metrics", "prometheuscommunity/postgres-exporter"),
                ],
            ),
        ];

        const { nodes, edges } = buildCanvas([resource("app"), resource("db")], graph, [], {}, {});

        expect(edges.map((edge) => edge.id)).toEqual(["reference:app:db"]);
        expect(buildEdges(nodes, graph)).toEqual(edges);
    });
});

describe("foldExporters", () => {
    const exporter = "prometheuscommunity/postgres-exporter:v0.20.1";

    // SAFETY: folding only reads each entry's `id` and `references`, and its services' `name` and `image`.
    const entry = (id: string, references: string[], ...images: string[]) =>
        ({
            id,
            references,
            services: images.map((image) => ({ name: image.split(":")[0], image })),
        }) as never;

    it("folds a database's exporter into a tray on its server", () => {
        expect(
            foldExporters([entry("db", [], "postgres:18-alpine", exporter)]).map(
                ({ services }) => services,
            ),
        ).toEqual([
            [
                {
                    name: "postgres",
                    image: "postgres:18-alpine",
                    exporters: ["prometheuscommunity/postgres-exporter"],
                },
            ],
        ]);
    });

    it("folds a separate exporter resource into the database it references", () => {
        const folded = foldExporters([
            entry("db", [], "timescale/timescaledb:2.31.0-pg18"),
            entry("metrics", ["db"], exporter),
        ]);

        expect(folded.map(({ id }) => id)).toEqual(["db"]);
        expect(folded[0]?.services[0]).toMatchObject({
            exporters: ["prometheuscommunity/postgres-exporter"],
        });
    });

    it("leaves an exporter without a database server as a card", () => {
        const graph = [entry("metrics", ["web"], exporter), entry("web", [], "nginx")];

        expect(foldExporters(graph)).toEqual(graph);
    });
});
