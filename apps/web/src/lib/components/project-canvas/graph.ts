import type { AppRouterClient } from "@stoat/api/routers/index";
import type { Edge, Node, XYPosition } from "@xyflow/svelte";
import { imageIcon } from "$lib/resources/image-icons";

export type CanvasResource = Awaited<
    ReturnType<AppRouterClient["resources"]["listResources"]>
>[number];

export type CanvasGraph = Awaited<
    ReturnType<AppRouterClient["resources"]["getProjectGraph"]>
>["resources"];

/** Template app id to logo, shared by every service that runs that template's image. */
export type CanvasLogos = Record<string, string>;

export type CanvasService = CanvasGraph[number]["services"][number];

export type CardData = {
    resource: CanvasResource;
    /** Absent for buckets and resources without a readable Compose spec. */
    service: CanvasService | undefined;
    icon: string | null;
    draftOnly: boolean;
    parseError: boolean;
    /** Cards inside a group are named after their service; the group carries the resource name. */
    grouped: boolean;
};

export type GroupData = { resource: CanvasResource; icon: string | null; serviceCount: number };

export type CanvasNode = Node<CardData, "card"> | Node<GroupData, "stack">;

export type Positions = Record<string, XYPosition>;

// Railway's service card: 288×144 with 24px padding.
export const CARD_WIDTH = 288;

export const CARD_HEIGHT = 144;

// Railway's volume tray: 72px tall, starting 24px under the card, so 48px shows below it.
export const VOLUME_OVERLAP = 24;

const VOLUME_TRAY = 72;

// Measured from Railway's groups: 24px around and between cards, cards start 68px down.
const GROUP_PADDING = 24;

const GROUP_HEADER = 68;

const COLUMN_GAP = 96;

const ROW_GAP = 64;

// Stacks with more services than this wrap into two columns.
const MAX_STACK = 4;

// Target width:height of the auto layout, close to a desktop viewport.
const ASPECT_RATIO = 16 / 9;

/** `<resourceId>` for top-level nodes, `<resourceId>:<service>` for cards inside a group. */
export function serviceNodeId(resourceId: string, service: string) {
    return `${resourceId}:${service}`;
}

function cardHeight(service: CanvasService | undefined) {
    return CARD_HEIGHT + (service?.volumes.length ? VOLUME_TRAY - VOLUME_OVERLAP : 0);
}

/**
 * Column per reference depth: resources nothing references sit on the left, the resources
 * they read from to their right. Reference cycles stop at the first repeat.
 */
function columns(graph: CanvasGraph) {
    const referencedBy = new Map<string, string[]>();

    for (const node of graph)
        for (const target of node.references)
            referencedBy.set(target, [...(referencedBy.get(target) ?? []), node.id]);

    const depth = new Map<string, number>();

    function visit(id: string, path: Set<string>): number {
        const known = depth.get(id);

        if (known !== undefined) return known;

        const parents = (referencedBy.get(id) ?? []).filter((parent) => !path.has(parent));

        const value =
            parents.length === 0
                ? 0
                : 1 + Math.max(...parents.map((parent) => visit(parent, new Set([...path, id]))));

        depth.set(id, value);

        return value;
    }

    for (const node of graph) visit(node.id, new Set());

    return depth;
}

type Rect = { x: number; y: number; width: number; height: number };

type Block = {
    resource: CanvasResource;
    entry: CanvasGraph[number] | undefined;
    width: number;
    height: number;
    /** Card positions relative to the group; empty for a lone card. */
    cards: { service: CanvasService; rect: Rect }[];
};

function block(resource: CanvasResource, entry: CanvasGraph[number] | undefined): Block {
    const services = entry?.services ?? [];

    if (services.length < 2)
        return { resource, entry, width: CARD_WIDTH, height: cardHeight(services[0]), cards: [] };

    // Big stacks wrap into two columns instead of growing into a tower.
    const columnCount = services.length > MAX_STACK ? 2 : 1;
    const cards: Block["cards"] = [];
    let y = GROUP_HEADER;

    for (let start = 0; start < services.length; start += columnCount) {
        const row = services.slice(start, start + columnCount);
        const rowHeight = Math.max(...row.map(cardHeight));

        row.forEach((service, column) =>
            cards.push({
                service,
                rect: {
                    x: GROUP_PADDING + column * (CARD_WIDTH + GROUP_PADDING),
                    y,
                    width: CARD_WIDTH,
                    height: rowHeight,
                },
            }),
        );
        y += rowHeight + GROUP_PADDING;
    }

    return {
        resource,
        entry,
        width: columnCount * CARD_WIDTH + (columnCount + 1) * GROUP_PADDING,
        height: y,
        cards,
    };
}

/**
 * Reference depth decides the column order; each depth then wraps into as many columns as
 * keep the whole canvas roughly landscape, like Railway's grid.
 */
function autoLayout(blocks: Block[], depth: Map<string, number>) {
    const area = blocks.reduce(
        (total, item) => total + (item.width + COLUMN_GAP) * (item.height + ROW_GAP),
        0,
    );

    const maxHeight = Math.max(
        ...blocks.map((item) => item.height),
        Math.sqrt(area / ASPECT_RATIO),
    );

    const depths = [...new Set(blocks.map((item) => depth.get(item.resource.id) ?? 0))].toSorted(
        (a, b) => a - b,
    );

    const positions = new Map<string, XYPosition>();
    let x = 0;

    for (const level of depths) {
        let y = 0;
        let columnWidth = 0;

        for (const item of blocks) {
            if ((depth.get(item.resource.id) ?? 0) !== level) continue;

            if (y > 0 && y + item.height > maxHeight) {
                x += columnWidth + COLUMN_GAP;
                y = 0;
                columnWidth = 0;
            }

            positions.set(item.resource.id, { x, y });
            y += item.height + ROW_GAP;
            columnWidth = Math.max(columnWidth, item.width);
        }

        x += columnWidth + COLUMN_GAP;
    }

    return positions;
}

/** Handles on the sides that face each other, so edges stay short wherever nodes are dragged. */
function facingHandles(source: Rect, target: Rect) {
    const dx = target.x + target.width / 2 - (source.x + source.width / 2);
    const dy = target.y + target.height / 2 - (source.y + source.height / 2);

    if (Math.abs(dx) > Math.abs(dy))
        return dx > 0
            ? { sourceHandle: "right", targetHandle: "left" }
            : { sourceHandle: "left", targetHandle: "right" };

    return dy > 0
        ? { sourceHandle: "bottom", targetHandle: "top" }
        : { sourceHandle: "top", targetHandle: "bottom" };
}

export function buildCanvas(
    resources: CanvasResource[],
    graph: CanvasGraph,
    logos: CanvasLogos,
    saved: Positions,
) {
    // Uploaded resource icons win; otherwise a matching template logo, then a known image.
    const serviceIcon = (service: CanvasService | undefined) =>
        (service?.template ? logos[service.template] : undefined) ?? imageIcon(service?.image);

    const byId = new Map(graph.map((node) => [node.id, node]));
    const blocks = resources.map((resource) => block(resource, byId.get(resource.id)));
    const auto = autoLayout(blocks, columns(graph));
    const rects = new Map<string, Rect>();
    const nodes: CanvasNode[] = [];
    const edges: Edge[] = [];

    for (const item of blocks) {
        const { resource, entry } = item;
        const draftOnly = entry?.draftOnly ?? false;
        const position = saved[resource.id] ?? auto.get(resource.id) ?? { x: 0, y: 0 };

        rects.set(resource.id, { ...position, width: item.width, height: item.height });

        if (item.cards.length === 0) {
            nodes.push({
                id: resource.id,
                type: "card",
                position,
                width: item.width,
                height: item.height,
                data: {
                    resource,
                    service: entry?.services[0],
                    icon: resource.icon ?? serviceIcon(entry?.services[0]),
                    draftOnly,
                    parseError: entry?.parseError ?? false,
                    grouped: false,
                },
            });
            continue;
        }

        // A parent must precede its children in the node array.
        nodes.push({
            id: resource.id,
            type: "stack",
            position,
            width: item.width,
            height: item.height,
            data: {
                resource,
                icon:
                    resource.icon ??
                    item.cards.map(({ service }) => serviceIcon(service)).find(Boolean) ??
                    null,
                serviceCount: item.cards.length,
            },
        });

        for (const { service, rect } of item.cards) {
            const id = serviceNodeId(resource.id, service.name);

            rects.set(id, rect);
            nodes.push({
                id,
                type: "card",
                parentId: resource.id,
                extent: "parent",
                draggable: false,
                position: { x: rect.x, y: rect.y },
                width: rect.width,
                height: rect.height,
                data: {
                    resource,
                    service,
                    icon: serviceIcon(service),
                    draftOnly,
                    parseError: false,
                    grouped: true,
                },
            });
        }
    }

    for (const item of blocks) {
        const { resource, entry } = item;

        // A lone card has no in-stack edges; `rects` only holds services drawn inside a group.
        for (const service of entry?.services ?? []) {
            for (const dependency of service.dependsOn) {
                const source = serviceNodeId(resource.id, service.name);
                const target = serviceNodeId(resource.id, dependency);
                const from = rects.get(source);
                const to = rects.get(target);

                if (!from || !to) continue;

                edges.push({
                    id: `depends:${source}:${dependency}`,
                    source,
                    target,
                    // Children share the parent's origin, so their relative rects compare directly.
                    ...facingHandles(from, to),
                });
            }
        }

        for (const target of entry?.references ?? []) {
            const from = rects.get(resource.id);
            const to = rects.get(target);

            if (!from || !to) continue;

            edges.push({
                id: `reference:${resource.id}:${target}`,
                source: resource.id,
                target,
                ...facingHandles(from, to),
            });
        }
    }

    return { nodes, edges };
}

function storageKey(projectId: string) {
    return `stoat:canvas:${projectId}`;
}

// Layout is a per-browser convenience: private windows and blocked storage fall back to auto.
export function loadPositions(projectId: string): Positions {
    try {
        const stored = localStorage.getItem(storageKey(projectId));

        // SAFETY: this key is only written by savePositions below.
        return stored ? (JSON.parse(stored) as Positions) : {};
    } catch {
        return {};
    }
}

export function savePositions(projectId: string, positions: Positions) {
    try {
        localStorage.setItem(storageKey(projectId), JSON.stringify(positions));
    } catch {
        // Unsaved layout only resets on the next visit.
    }
}

export function clearPositions(projectId: string) {
    try {
        localStorage.removeItem(storageKey(projectId));
    } catch {
        // Nothing stored to clear.
    }
}
