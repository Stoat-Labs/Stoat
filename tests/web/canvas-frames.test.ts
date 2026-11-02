import { describe, expect, it } from "vite-plus/test";

import {
    buildCanvas,
    cardTrays,
    moveResourceCards,
    foldExporters,
    frameRect,
    freeSlot,
    refitFrames,
    repairOverlaps,
    settle,
    type CanvasService,
} from "../../apps/web/src/lib/components/canvas/graph";

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
        // SAFETY: the canvas only reads `groupId` while refitting.
        const card = (id: string, x: number, y: number) =>
            ({
                id,
                type: "card",
                position: { x, y },
                width: 288,
                height: 144,
                data: { groupId: "r" },
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
    // SAFETY: repairOverlaps only reads ids, types, positions, sizes and `groupId`.
    const card = (id: string, x: number, y: number, groupId?: string) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { groupId },
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
    // SAFETY: settle only reads ids, types, positions, sizes, `hidden` and `groupId`.
    const card = (id: string, x: number, y: number, groupId?: string) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { groupId },
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

    // SAFETY: the layout only reads `id`, `icon`, `engine` and `groupId` of a resource.
    const resource = (id: string, groupId: string | null = null) =>
        ({ id, icon: null, engine: null, groupId }) as never;

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

    it("draws a resource with several services as one card, a row per service and its trays under it", () => {
        const { nodes } = buildCanvas(
            [resource("sure")],
            [
                entry(
                    "sure",
                    [],
                    [
                        service("web", ["storage"]),
                        service("worker", ["storage"]),
                        service("db", ["data"]),
                        service("metrics"),
                        service("redis", ["cache"], ["redis.conf"]),
                    ],
                ),
            ],
            [],
            {},
            {},
        );

        expect(nodes.map((node) => node.id)).toEqual(["sure"]);
        // 144 plus five 32px service rows, then four 48px trays: web and worker share storage.
        expect(nodes[0]?.height).toBe(144 + 5 * 32 + 4 * 48);
    });

    it("shows a volume or config several services mount as one tray", () => {
        expect(
            cardTrays([
                service("web", ["storage"], ["app.conf"]),
                service("worker", ["storage", "cache"], ["app.conf"]),
            ]),
        ).toEqual([
            { kind: "volume", name: "storage" },
            { kind: "volume", name: "cache" },
            { kind: "config", name: "app.conf" },
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

    it("keeps the spot a service had in its resource's old frame", () => {
        const { nodes } = buildCanvas(
            [resource("sure")],
            [entry("sure", [], [service("web"), service("db")])],
            [],
            {},
            { "sure:web": { x: 480, y: 600 } },
        );

        expect(nodes[0]?.position).toEqual({ x: 480, y: 600 });
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
