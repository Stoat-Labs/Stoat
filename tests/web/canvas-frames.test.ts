import { describe, expect, it } from "vite-plus/test";

import {
    buildCanvas,
    frameRect,
    freeSlot,
    refitFrames,
    repairOverlaps,
    settle,
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
        const resource = { id: "r" };

        // SAFETY: the canvas only reads `resource.id` and `grouped` while refitting.
        const card = (id: string, x: number, y: number) =>
            ({
                id,
                type: "card",
                position: { x, y },
                width: 288,
                height: 144,
                data: { resource, grouped: true },
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
            card("r:a", 24, 48),
            card("r:b", 1000, 900),
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
    const resource = { id: "stack" };

    // SAFETY: repairOverlaps only reads ids, types, positions, sizes and `grouped`.
    const card = (id: string, x: number, y: number, grouped = false) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { resource: grouped ? resource : { id }, grouped },
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

        const moved = repairOverlaps([card("a", 0, 0), frame, card("stack:x", 24, 144, true)]);

        expect(moved["stack:x"]).toEqual({ x: 24, y: 216 });
    });
});

describe("settle", () => {
    // SAFETY: settle only reads ids, types, positions, sizes, `hidden` and `grouped`.
    const card = (id: string, x: number, y: number, resource = id, grouped = false) =>
        ({
            id,
            type: "card",
            position: { x, y },
            width: 288,
            height: 144,
            data: { resource: { id: resource }, grouped },
        }) as never;

    it("leaves a card that covers nothing where it was dropped", () => {
        expect(settle([card("a", 0, 0), card("b", 600, 0)], "b")).toEqual({
            b: { x: 600, y: 0 },
        });
    });

    it("moves a card dropped on another to the nearest free grid spot, keeping a gap", () => {
        const moved = settle([card("a", 0, 0), card("b", 48, 24)], "b");

        const { x, y } = moved.b ?? { x: 0, y: 0 };
        const clear = x >= 288 + 24 || x + 288 + 24 <= 0 || y >= 144 + 24 || y + 144 + 24 <= 0;

        expect(clear).toBe(true);
        expect(x % 24 === 0 && y % 24 === 0).toBe(true);
    });

    it("keeps a card inside a frame off its siblings", () => {
        const moved = settle(
            [card("s:a", 0, 48, "s", true), card("s:b", 24, 72, "s", true)],
            "s:b",
        );

        const { x, y } = moved["s:b"] ?? { x: 0, y: 0 };

        expect(Math.abs(y - 48) >= 144 + 24 || Math.abs(x) >= 288 + 24).toBe(true);
    });
});

describe("buildCanvas", () => {
    it("sizes each stack card to itself, so a card beside a volume tray keeps its edges on its border", () => {
        const service = (name: string, volumes: string[]) => ({
            name,
            image: null,
            dependsOn: [],
            volumes,
            isNew: false,
            domains: [],
            internalHostname: null,
        });

        // SAFETY: the layout only reads `id` and `icon` of the resource.
        const resource = { id: "sure", icon: null } as never;

        // SAFETY: the layout only reads the fields given here.
        const graph = [
            {
                id: "sure",
                draftOnly: true,
                parseError: false,
                references: [],
                services: [
                    service("web", ["storage"]),
                    service("worker", ["storage"]),
                    service("db", ["data"]),
                    service("metrics", []),
                    service("redis", ["cache"]),
                ],
            },
        ] as never;

        const { nodes } = buildCanvas([resource], graph, {}, {});
        const height = (id: string) => nodes.find((node) => node.id === id)?.height;

        expect(height("sure:db")).toBe(192);
        expect(height("sure:metrics")).toBe(144);
    });
});
