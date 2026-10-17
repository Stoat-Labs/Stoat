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

export type GroupData = {
    resource: CanvasResource;
    icon: string | null;
    serviceCount: number;
    /** A dragged card from another resource hovers this frame and would move in on drop. */
    dropTarget: boolean;
    /** Railway's "Hide contents": the frame shrinks to a card showing its services' icons. */
    collapsed: boolean;
    services: { name: string; icon: string | null }[];
};

// Railway's collapsed group card.
export const COLLAPSED_WIDTH = 288;

export const COLLAPSED_HEIGHT = 264;

export type CanvasNode = Node<CardData, "card"> | Node<GroupData, "stack">;

export type Positions = Record<string, XYPosition>;

// Railway's service card: 288×144 with 24px padding.
export const CARD_WIDTH = 288;

export const CARD_HEIGHT = 144;

// Railway's volume tray: 72px tall, starting 24px under the card, so 48px shows below it.
export const VOLUME_OVERLAP = 24;

const VOLUME_TRAY = 72;

// Measured from Railway's groups: a frame wraps its cards' bounding box with 24px on the sides and
// bottom and 48px on top for the header.
const GROUP_PADDING = 24;

const GROUP_HEADER = 48;

export const COLUMN_GAP = 96;

// Railway snaps to a 24px grid, so every auto-layout gap is a multiple of 24.
const ROW_GAP = 48;

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

export type Rect = { x: number; y: number; width: number; height: number };

/** A frame around its cards, like Railway's groups: recomputed whenever a card moves. */
export function frameRect(cards: Rect[]): Rect {
    const left = Math.min(...cards.map((card) => card.x));
    const top = Math.min(...cards.map((card) => card.y));
    const right = Math.max(...cards.map((card) => card.x + card.width));
    const bottom = Math.max(...cards.map((card) => card.y + card.height));

    return {
        x: left - GROUP_PADDING,
        y: top - GROUP_HEADER,
        width: right - left + GROUP_PADDING * 2,
        height: bottom - top + GROUP_HEADER + GROUP_PADDING,
    };
}

/**
 * Where a card dropped into a frame should land: where it was dropped, unless that covers a card
 * already there, in which case the next free row under them.
 */
/** Where a card joins a frame from elsewhere: under its lowest card, in line with its first column. */
export function slotBelow(members: Rect[]): XYPosition {
    return {
        x: Math.min(...members.map((member) => member.x)),
        y: Math.max(...members.map((member) => member.y + member.height)) + GROUP_PADDING,
    };
}

export function freeSlot(drop: Rect, members: Rect[]): XYPosition {
    const overlaps = members.some(
        (member) =>
            drop.x < member.x + member.width &&
            member.x < drop.x + drop.width &&
            drop.y < member.y + member.height &&
            member.y < drop.y + drop.height,
    );

    if (!overlaps || !members.length) return { x: drop.x, y: drop.y };

    return {
        x: Math.min(...members.map((member) => member.x)),
        y: Math.max(...members.map((member) => member.y + member.height)) + GROUP_PADDING,
    };
}

/**
 * Railway's "Repair overlaps": frames and lone cards are blocks; each one that overlaps a block
 * placed before it (top to bottom) moves down below it, keeping a grid-sized gap.
 * Returns new positions for every card, so frames carry their cards.
 */
export function repairOverlaps(nodes: CanvasNode[]) {
    const blocks = nodes.flatMap((node) =>
        node.type === "stack" || !node.data.grouped
            ? [{ id: node.id, rect: nodeRect(node), frame: node.type === "stack" }]
            : [],
    );

    const placed: Rect[] = [];
    const shift = new Map<string, number>();

    for (const block of blocks.toSorted((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)) {
        const rect = { ...block.rect };

        for (let hit = overlapping(rect, placed); hit; hit = overlapping(rect, placed))
            rect.y =
                Math.ceil((hit.y + hit.height + GROUP_PADDING) / GROUP_PADDING) * GROUP_PADDING;

        placed.push(rect);
        shift.set(block.id, rect.y - block.rect.y);
    }

    const positions: Positions = {};

    for (const node of nodes) {
        if (node.type !== "card") continue;

        const delta = shift.get(node.data.grouped ? node.data.resource.id : node.id) ?? 0;

        positions[node.id] = { x: node.position.x, y: node.position.y + delta };
    }

    return positions;
}

function overlapping(rect: Rect, placed: Rect[]) {
    return placed.find(
        (other) =>
            rect.x < other.x + other.width + GROUP_PADDING &&
            other.x < rect.x + rect.width + GROUP_PADDING &&
            rect.y < other.y + other.height + GROUP_PADDING &&
            other.y < rect.y + rect.height + GROUP_PADDING,
    );
}

/** The closest grid spot to `rect` that keeps a gap from every obstacle, searching outwards. */
export function nearestFree(rect: Rect, obstacles: Rect[]): XYPosition {
    if (!overlapping(rect, obstacles)) return { x: rect.x, y: rect.y };

    const candidates: XYPosition[] = [];

    for (let ring = 1; ring <= 80; ring++)
        for (let dx = -ring; dx <= ring; dx++)
            for (let dy = -ring; dy <= ring; dy++)
                if (Math.max(Math.abs(dx), Math.abs(dy)) === ring)
                    candidates.push({ x: dx * GROUP_PADDING, y: dy * GROUP_PADDING });

    const ordered = candidates.toSorted((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));

    for (const offset of ordered) {
        const moved = { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };

        if (!overlapping(moved, obstacles)) return { x: moved.x, y: moved.y };
    }

    return { x: rect.x, y: rect.y };
}

/**
 * Cards never overlap: the dragged node settles into the nearest free spot. A card inside a
 * frame avoids its siblings and every other block; a frame or lone card avoids every other block.
 * Returns new card positions for whatever moved.
 */
export function settle(nodes: CanvasNode[], draggedId: string) {
    const dragged = nodes.find((node) => node.id === draggedId);

    if (!dragged) return {};

    const blocks = nodes.filter(
        (node) => !node.hidden && (node.type === "stack" || !node.data.grouped),
    );

    const ownFrame =
        dragged.type === "card" && dragged.data.grouped ? dragged.data.resource.id : undefined;

    const obstacles = [
        ...blocks.filter((node) => node.id !== draggedId && node.id !== ownFrame),
        ...(ownFrame
            ? nodes.filter(
                  (node) =>
                      node.type === "card" &&
                      node.data.grouped &&
                      node.data.resource.id === ownFrame &&
                      node.id !== draggedId,
              )
            : []),
    ].map(nodeRect);

    const spot = nearestFree(nodeRect(dragged), obstacles);
    const delta = { x: spot.x - dragged.position.x, y: spot.y - dragged.position.y };
    const positions: Positions = {};

    for (const node of nodes) {
        const moves =
            node.id === draggedId ||
            (dragged.type === "stack" &&
                node.type === "card" &&
                node.data.grouped &&
                node.data.resource.id === draggedId);

        if (node.type === "card" && moves)
            positions[node.id] = { x: node.position.x + delta.x, y: node.position.y + delta.y };
    }

    return positions;
}

export function nodeRect(node: CanvasNode): Rect {
    return { ...node.position, width: node.width ?? 0, height: node.height ?? 0 };
}

/** Frames refitted to where their cards are now; cards and edges are untouched. */
export function refitFrames(nodes: CanvasNode[]) {
    const members = new Map<string, Rect[]>();

    for (const node of nodes)
        if (node.type === "card" && node.data.grouped)
            members.set(node.data.resource.id, [
                ...(members.get(node.data.resource.id) ?? []),
                nodeRect(node),
            ]);

    return nodes.map((node) => {
        const cards = node.type === "stack" ? members.get(node.id) : undefined;

        if (!cards?.length || node.type !== "stack") return node;

        const frame = frameRect(cards);

        // A collapsed frame keeps its card size, anchored where the full frame would start.
        return {
            ...node,
            position: { x: frame.x, y: frame.y },
            width: node.data.collapsed ? COLLAPSED_WIDTH : frame.width,
            height: node.data.collapsed ? COLLAPSED_HEIGHT : frame.height,
        };
    });
}

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
                    // Its own height, not the row's: edges attach to the node's sides, so a card
                    // without volumes beside one with them would get handles below its border.
                    height: cardHeight(service),
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
    collapsed: ReadonlySet<string> = new Set(),
) {
    // Uploaded resource icons win; otherwise a matching template logo, then a known image.
    const serviceIcon = (service: CanvasService | undefined) =>
        (service?.template ? logos[service.template] : undefined) ?? imageIcon(service?.image);

    const byId = new Map(graph.map((node) => [node.id, node]));
    const blocks = resources.map((resource) => block(resource, byId.get(resource.id)));
    const auto = autoLayout(blocks, columns(graph));
    const frames: CanvasNode[] = [];
    const cards: CanvasNode[] = [];

    for (const item of blocks) {
        const { resource, entry } = item;
        const draftOnly = entry?.draftOnly ?? false;
        const origin = auto.get(resource.id) ?? { x: 0, y: 0 };

        if (item.cards.length === 0) {
            const service = entry?.services[0];

            cards.push({
                id: resource.id,
                type: "card",
                // A stack that shrank to one service keeps that service's spot.
                position:
                    saved[resource.id] ??
                    (service ? saved[serviceNodeId(resource.id, service.name)] : undefined) ??
                    origin,
                width: item.width,
                height: item.height,
                zIndex: 1,
                data: {
                    resource,
                    service,
                    icon: resource.icon ?? serviceIcon(service),
                    draftOnly,
                    parseError: entry?.parseError ?? false,
                    grouped: false,
                },
            });
            continue;
        }

        const members = item.cards.map(({ service, rect }) => {
            const id = serviceNodeId(resource.id, service.name);

            return {
                id,
                type: "card" as const,
                position: saved[id] ?? { x: origin.x + rect.x, y: origin.y + rect.y },
                width: rect.width,
                height: rect.height,
                zIndex: 1,
                data: {
                    resource,
                    service,
                    icon: serviceIcon(service),
                    draftOnly,
                    parseError: false,
                    grouped: true,
                },
            };
        });

        const frame = frameRect(
            members.map((member) => ({
                ...member.position,
                width: member.width,
                height: member.height,
            })),
        );

        const isCollapsed = collapsed.has(resource.id);

        // Frames sit behind every card and edge, like Railway's; a collapsed one is a card itself.
        frames.push({
            id: resource.id,
            type: "stack",
            position: { x: frame.x, y: frame.y },
            width: isCollapsed ? COLLAPSED_WIDTH : frame.width,
            height: isCollapsed ? COLLAPSED_HEIGHT : frame.height,
            zIndex: isCollapsed ? 1 : -1,
            data: {
                collapsed: isCollapsed,
                services: item.cards.map(({ service }) => ({
                    name: service.name,
                    icon: serviceIcon(service),
                })),
                resource,
                icon:
                    resource.icon ??
                    item.cards.map(({ service }) => serviceIcon(service)).find(Boolean) ??
                    null,
                serviceCount: item.cards.length,
                dropTarget: false,
            },
        });
        // Hidden cards keep their positions, so showing the contents restores the layout.
        cards.push(...members.map((member) => ({ ...member, hidden: isCollapsed })));
    }

    const nodes = [...frames, ...cards];

    return { nodes, edges: buildEdges(nodes, graph) };
}

/** Dependency and reference edges, attached to the sides of each pair that face each other. */
export function buildEdges(nodes: CanvasNode[], graph: CanvasGraph) {
    // Cards hidden in a collapsed frame have no edges; references still reach the frame.
    const rects = new Map(
        nodes.flatMap((node) => (node.hidden ? [] : [[node.id, nodeRect(node)] as const])),
    );

    const edges: Edge[] = [];

    for (const entry of graph) {
        for (const service of entry.services) {
            for (const dependency of service.dependsOn) {
                const source = serviceNodeId(entry.id, service.name);
                const target = serviceNodeId(entry.id, dependency);
                const from = rects.get(source);
                const to = rects.get(target);

                if (!from || !to) continue;

                edges.push({
                    id: `depends:${source}:${dependency}`,
                    source,
                    target,
                    ...facingHandles(from, to),
                });
            }
        }

        for (const target of entry.references) {
            const from = rects.get(entry.id);
            const to = rects.get(target);

            if (!from || !to) continue;

            edges.push({
                id: `reference:${entry.id}:${target}`,
                source: entry.id,
                target,
                ...facingHandles(from, to),
            });
        }
    }

    return edges;
}

function storageKey(projectId: string) {
    // v3: entries carry a TTL.
    return `stoat:canvas:v3:${projectId}`;
}

// Teammates share the layout, so the local copy only wins for a short while.
const POSITIONS_TTL_MS = 5 * 60_000;

type StoredPositions = { positions: Positions; expiresAt: number };

// Local copy of the project's layout: it is written first, so a reload inside the server save's
// debounce window or after a failed save keeps the latest drags. Every change renews its TTL;
// once expired (or with blocked storage) the server layout is used.
export function loadPositions(projectId: string): Positions | undefined {
    try {
        const stored = localStorage.getItem(storageKey(projectId));

        if (!stored) return undefined;

        // SAFETY: this key is only written by savePositions below.
        const entry = JSON.parse(stored) as StoredPositions;

        if (entry.expiresAt > Date.now()) return entry.positions;

        localStorage.removeItem(storageKey(projectId));

        return undefined;
    } catch {
        return undefined;
    }
}

export function savePositions(projectId: string, positions: Positions) {
    try {
        const entry: StoredPositions = {
            positions,
            expiresAt: Date.now() + POSITIONS_TTL_MS,
        };

        localStorage.setItem(storageKey(projectId), JSON.stringify(entry));
    } catch {
        // The server copy still saves.
    }
}

function collapsedKey(projectId: string) {
    return `stoat:canvas:v2:collapsed:${projectId}`;
}

// Which frames show only their icons; per browser, like the layout.
export function loadCollapsed(projectId: string): Set<string> {
    try {
        const stored = localStorage.getItem(collapsedKey(projectId));

        // SAFETY: this key is only written by saveCollapsed below.
        return new Set(stored ? (JSON.parse(stored) as string[]) : []);
    } catch {
        return new Set();
    }
}

export function saveCollapsed(projectId: string, collapsed: ReadonlySet<string>) {
    try {
        localStorage.setItem(collapsedKey(projectId), JSON.stringify([...collapsed]));
    } catch {
        // Unsaved state only resets on the next visit.
    }
}
