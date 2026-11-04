import type { AppRouterClient } from "@stoat/api/routers/index";
import type { Edge, Node, XYPosition } from "@xyflow/svelte";
import { databaseExporterEngine, databaseServerEngine } from "@stoat/api/observability";
import { engineIcon, imageIcon } from "$lib/resources/image-icons";

export type CanvasResource = Awaited<
    ReturnType<AppRouterClient["resources"]["listResources"]>
>[number];

export type CanvasGraph = Awaited<
    ReturnType<AppRouterClient["resources"]["getProjectGraph"]>
>["resources"];

/** Template app id to logo, shared by every service that runs that template's image. */
export type CanvasLogos = Record<string, string>;

export type CanvasService = CanvasGraph[number]["services"][number] & {
    /** Exporter services folded into this database server's card; see `foldExporters`. */
    exporters?: string[];
};

export type CanvasVolume = CanvasGraph[number]["volumes"][number];

export type CanvasConfig = CanvasGraph[number]["configs"][number];

export type CanvasGroup = Awaited<ReturnType<AppRouterClient["resources"]["listGroups"]>>[number];

export type CardData = {
    resource: CanvasResource;
    /** The service this card shows; absent for buckets, unreadable specs, volumes and configs. */
    service: CanvasService | undefined;
    /** One of several services of its resource: the card carries the service's name. */
    shared: boolean;
    icon: string | null;
    draftOnly: boolean;
    parseError: boolean;
    /** The group the card's resource belongs to. */
    groupId: string | undefined;
    /** The frame the card sits in: its group's, or its resource's own for several services outside one. */
    frameId: string | undefined;
    /** Set on a volume no service mounts: it stands alone on the canvas instead of in a tray. */
    volume: CanvasVolume | undefined;
    /** Set on a config no service mounts, like `volume`. */
    config?: CanvasConfig;
};

export type GroupData = {
    /** Absent on a resource's own frame around its services. */
    group: CanvasGroup | undefined;
    name: string;
    projectId: string;
    icon: string | null;
    /** A dragged card from outside hovers this frame and would join it on drop. */
    dropTarget: boolean;
    /** Railway's "Hide contents": the frame shrinks to a card showing its cards' icons. */
    collapsed: boolean;
    /** One entry per card: a resource, or a service of one. */
    resources: { id: string; resourceId: string; name: string; icon: string | null }[];
};

// Railway's collapsed group card.
export const COLLAPSED_WIDTH = 288;

export const COLLAPSED_HEIGHT = 264;

export type CanvasNode = Node<CardData, "card"> | Node<GroupData, "stack">;

export type Positions = Record<string, XYPosition>;

export const SNAP_GRID = 24;

// Railway's service card: 288×144 with 24px padding.
export const CARD_WIDTH = 288;

export const CARD_HEIGHT = 144;

// Railway's volume tray: 72px tall, starting 24px under the card, so 48px shows below it.
export const VOLUME_OVERLAP = 24;

export const VOLUME_TRAY = 72;

// A volume without a service is a card of its own: just a header and the mounts line.
const VOLUME_CARD_HEIGHT = 96;

// Measured from Railway's groups: a frame wraps its cards' bounding box with 24px on the sides and
// bottom and 48px on top for the header.
const GROUP_PADDING = 24;

const GROUP_HEADER = 48;

export const COLUMN_GAP = 96;

// Railway snaps to a 24px grid, so every auto-layout gap is a multiple of 24.
const ROW_GAP = 48;

// Groups with more cards than this wrap into two columns.
const MAX_STACK = 4;

// Target width:height of the auto layout, close to a desktop viewport.
const ASPECT_RATIO = 16 / 9;

/** `<resourceId>:<service>`: the card of one service of a resource with several. */
export function serviceNodeId(resourceId: string, service: string) {
    return `${resourceId}:${service}`;
}

/** `<resourceId>/<volume>`: resource ids and volume names never contain a slash. */
export function volumeNodeId(resourceId: string, volume: string) {
    return `${resourceId}/${volume}`;
}

/** `<resourceId>#<config>`, apart from volumes, which may share a config's name. */
export function configNodeId(resourceId: string, config: string) {
    return `${resourceId}#${config}`;
}

/** Takes a node id apart, whichever kind of node it names. */
export function parseNodeId(nodeId: string) {
    const split = nodeId.indexOf("#");

    if (split >= 0)
        return {
            resourceId: nodeId.slice(0, split),
            service: undefined,
            volume: undefined,
            config: nodeId.slice(split + 1),
        };

    const [resourceId = "", volume] = nodeId.split("/");

    if (volume !== undefined) return { resourceId, service: undefined, volume, config: undefined };

    const [id = "", ...service] = nodeId.split(":");

    return {
        resourceId: id,
        service: service.length ? service.join(":") : undefined,
        volume,
        config: undefined,
    };
}

/** Where one axis of canvas dots lands, in whole pixels: mid-cell, so none touches a snapped card's edge. */
export function gridDots(origin: number, gap: number, length: number) {
    const dots: number[] = [];

    for (let dot = (origin + gap / 2) % gap; dot < length; dot += gap) {
        dots.push(Math.round(dot));
    }

    return dots;
}

/** Volume trays, then config trays, then metrics trays, each tucked under the one above. */
export function cardTrays(service: CanvasService | undefined) {
    return [
        ...(service?.volumes ?? []).map((name) => ({ kind: "volume" as const, name })),
        ...(service?.configs ?? []).map((name) => ({ kind: "config" as const, name })),
        // Two exporter resources folded into one database can share a service name.
        ...[...new Set(service?.exporters)].map((name) => ({ kind: "metrics" as const, name })),
    ];
}

/** The containers behind each entry of a frame's status line: a group's resources, or a resource's own services. */
export function frameContainers<T extends { service: string }>(
    data: GroupData,
    containers: Record<string, T[]> | undefined,
) {
    if (data.group)
        return [...new Set(data.resources.map(({ resourceId }) => resourceId))].map(
            (resourceId) => containers?.[resourceId] ?? [],
        );

    return data.resources.map(({ resourceId, name }) =>
        (containers?.[resourceId] ?? []).filter(({ service }) => service === name),
    );
}

/** Adds `exporters` as trays on `server`, one of `entry`'s services. */
function withExporters(
    entry: CanvasGraph[number],
    server: CanvasService,
    exporters: string[],
): CanvasGraph[number] {
    return {
        ...entry,
        services: entry.services.map((service) =>
            service === server
                ? { ...service, exporters: [...(server.exporters ?? []), ...exporters] }
                : service,
        ),
    };
}

/**
 * A database's exporters become trays under the database server they scrape instead of cards,
 * so a database with its metrics is one card, not a group. That holds for exporter services in
 * the database's own Compose, and for a resource of only exporters referencing the database.
 */
export function foldExporters(graph: CanvasGraph): CanvasGraph {
    const exporterEngine = (service: CanvasService) =>
        service.image ? databaseExporterEngine(service.image) : undefined;

    const serverOf = (entry: CanvasGraph[number], engine?: string) =>
        entry.services.find((service) => {
            const server = service.image ? databaseServerEngine(service.image) : undefined;

            return server !== undefined && (engine === undefined || server === engine);
        });

    const byId = new Map(
        graph.map((entry) => {
            const server = serverOf(entry);
            const exporters = entry.services.filter((service) => exporterEngine(service));

            if (!server || exporters.length === 0) return [entry.id, entry];
            const names = exporters.map((service) => service.name);

            return [
                entry.id,
                withExporters(
                    {
                        ...entry,
                        services: entry.services.filter((service) => !names.includes(service.name)),
                    },
                    server,
                    names,
                ),
            ];
        }),
    );

    for (const entry of graph) {
        const engine = entry.services[0] && exporterEngine(entry.services[0]);

        if (!engine || !entry.services.every((service) => exporterEngine(service) === engine))
            continue;

        const database = entry.references
            .map((id) => byId.get(id))
            .find((target) => target && serverOf(target, engine));

        const server = database && serverOf(database, engine);

        if (!database || !server) continue;
        byId.set(
            database.id,
            withExporters(
                database,
                server,
                entry.services.map((service) => service.name),
            ),
        );
        byId.delete(entry.id);
    }

    return [...byId.values()];
}

function cardHeight(service: CanvasService | undefined) {
    return CARD_HEIGHT + cardTrays(service).length * (VOLUME_TRAY - VOLUME_OVERLAP);
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

/** Where a card joins a frame from elsewhere: under its lowest card, in line with its first column. */
export function slotBelow(members: Rect[]): XYPosition {
    return {
        x: Math.min(...members.map((member) => member.x)),
        y: Math.max(...members.map((member) => member.y + member.height)) + GROUP_PADDING,
    };
}

/**
 * Where a card dropped into a frame should land: where it was dropped, unless that covers a card
 * already there, in which case the next free row under them.
 */
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
        node.type === "stack" || !node.data.frameId
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

        const delta = shift.get(node.data.frameId ?? node.id) ?? 0;

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

/**
 * Cards may overlap, just not bury each other: a card covering most of another must leave at
 * least a grid step of its top and left edge showing, so it cascades down-right until it does.
 */
function cascade(rect: Rect, obstacles: Rect[]): XYPosition {
    const buried = (spot: XYPosition) =>
        obstacles.find((other) => {
            const dx = spot.x - other.x;
            const dy = spot.y - other.y;

            const mostlyCovered =
                Math.abs(dx) < Math.min(rect.width, other.width) / 2 &&
                Math.abs(dy) < Math.min(rect.height, other.height) / 2;

            return mostlyCovered && (Math.abs(dx) < GROUP_PADDING || Math.abs(dy) < GROUP_PADDING);
        });

    let spot = { x: rect.x, y: rect.y };

    // Positions only grow, so a fixed card never buries the same one again.
    for (let hit = buried(spot); hit; hit = buried(spot))
        spot = {
            x: Math.abs(spot.x - hit.x) < GROUP_PADDING ? hit.x + GROUP_PADDING : spot.x,
            y: Math.abs(spot.y - hit.y) < GROUP_PADDING ? hit.y + GROUP_PADDING : spot.y,
        };

    return spot;
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
 * Cards never sit right on top of each other: the dragged node cascades off any card it landed
 * on (partial overlap is fine). A card inside a
 * frame avoids its siblings and every other block; a frame or lone card avoids every other block.
 * Returns new card positions for whatever moved.
 */
export function settle(nodes: CanvasNode[], draggedId: string) {
    const dragged = nodes.find((node) => node.id === draggedId);

    if (!dragged) return {};

    const blocks = nodes.filter(
        (node) => !node.hidden && (node.type === "stack" || !node.data.frameId),
    );

    const ownFrame = dragged.type === "card" ? dragged.data.frameId : undefined;

    const obstacles = [
        ...blocks.filter((node) => node.id !== draggedId && node.id !== ownFrame),
        ...(ownFrame
            ? nodes.filter(
                  (node) =>
                      node.type === "card" &&
                      node.data.frameId === ownFrame &&
                      node.id !== draggedId,
              )
            : []),
    ].map(nodeRect);

    const spot = cascade(nodeRect(dragged), obstacles);
    const delta = { x: spot.x - dragged.position.x, y: spot.y - dragged.position.y };
    const positions: Positions = {};

    for (const node of nodes) {
        const moves =
            node.id === draggedId ||
            (dragged.type === "stack" && node.type === "card" && node.data.frameId === draggedId);

        if (node.type === "card" && moves)
            positions[node.id] = { x: node.position.x + delta.x, y: node.position.y + delta.y };
    }

    return positions;
}

/**
 * New positions when one of a resource's cards moves from `from` to `to`: its other service,
 * volume and config cards keep their offset from it, so they change frames with it.
 */
export function moveResourceCards(
    nodes: CanvasNode[],
    cardId: string,
    from: XYPosition,
    to: XYPosition,
) {
    const card = nodes.find((node) => node.id === cardId);
    const resourceId = card?.type === "card" ? card.data.resource.id : cardId;

    return Object.fromEntries([
        [cardId, to],
        ...nodes.flatMap((node) =>
            node.type === "card" && node.id !== cardId && node.data.resource.id === resourceId
                ? [
                      [
                          node.id,
                          {
                              x: node.position.x + to.x - from.x,
                              y: node.position.y + to.y - from.y,
                          },
                      ] as const,
                  ]
                : [],
        ),
    ]);
}

/**
 * `moveResourceCards` for a move into a frame: if any of the moving cards would cover a member,
 * they all shift together to the frame's next free row.
 */
export function landResourceCards(
    nodes: CanvasNode[],
    cardId: string,
    from: XYPosition,
    to: XYPosition,
    members: Rect[],
): Record<string, XYPosition> {
    const moves = moveResourceCards(nodes, cardId, from, to);

    const rects = nodes.flatMap((node) => {
        const position = moves[node.id];

        return position ? [{ ...nodeRect(node), ...position }] : [];
    });

    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));

    const free = freeSlot(
        {
            x: left,
            y: top,
            width: Math.max(...rects.map((rect) => rect.x + rect.width)) - left,
            height: Math.max(...rects.map((rect) => rect.y + rect.height)) - top,
        },
        members,
    );

    return Object.fromEntries(
        Object.entries(moves).map(([id, position]) => [
            id,
            { x: position.x + free.x - left, y: position.y + free.y - top },
        ]),
    );
}

export function nodeRect(node: CanvasNode): Rect {
    return { ...node.position, width: node.width ?? 0, height: node.height ?? 0 };
}

/** Frames refitted to where their cards are now; cards and edges are untouched. */
export function refitFrames(nodes: CanvasNode[]) {
    const members = new Map<string, Rect[]>();

    for (const node of nodes)
        if (node.type === "card" && node.data.frameId)
            members.set(node.data.frameId, [
                ...(members.get(node.data.frameId) ?? []),
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

/** One card: a service, a resource without one, or a volume or config no service mounts. */
type Item = {
    /** The resource id, a service's node id, or the node id of a volume or config that stands alone. */
    id: string;
    resource: CanvasResource;
    entry: CanvasGraph[number] | undefined;
    service?: CanvasService;
    volume?: CanvasVolume;
    config?: CanvasConfig;
    width: number;
    height: number;
};

/** What the auto layout places: a frame with its cards, or a card on its own. */
type Block = {
    /** The group id, the resource id for a resource's own frame, or the lone card's id. */
    id: string;
    group: CanvasGroup | undefined;
    framed: boolean;
    width: number;
    height: number;
    /** Card positions relative to the block. */
    cards: { item: Item; rect: Rect }[];
};

function loneBlock(item: Item): Block {
    return {
        id: item.id,
        group: undefined,
        framed: false,
        width: item.width,
        height: item.height,
        cards: [{ item, rect: { x: 0, y: 0, width: item.width, height: item.height } }],
    };
}

/** A group's frame, or (without `group`) a resource's own frame around its services. */
function frameBlock(id: string, group: CanvasGroup | undefined, items: Item[]): Block {
    // Big frames wrap into two columns instead of growing into a tower.
    const columnCount = items.length > MAX_STACK ? 2 : 1;
    const cards: Block["cards"] = [];
    let y = GROUP_HEADER;

    for (let start = 0; start < items.length; start += columnCount) {
        const row = items.slice(start, start + columnCount);

        row.forEach((item, column) =>
            cards.push({
                item,
                rect: {
                    x: GROUP_PADDING + column * (CARD_WIDTH + GROUP_PADDING),
                    y,
                    width: item.width,
                    // Its own height, not the row's: edges attach to the node's sides, so a short
                    // card beside a tall one would get handles below its border.
                    height: item.height,
                },
            }),
        );
        y += Math.max(...row.map((item) => item.height)) + GROUP_PADDING;
    }

    return {
        id,
        group,
        framed: true,
        width: columnCount * CARD_WIDTH + (columnCount + 1) * GROUP_PADDING,
        height: y,
        cards,
    };
}

/**
 * Reference depth decides the column order; each depth then wraps into as many columns as
 * keep the whole canvas roughly landscape, like Railway's grid.
 */
function autoLayout(blocks: Block[], depthOf: (block: Block) => number) {
    const area = blocks.reduce(
        (total, item) => total + (item.width + COLUMN_GAP) * (item.height + ROW_GAP),
        0,
    );

    const maxHeight = Math.max(
        ...blocks.map((item) => item.height),
        Math.sqrt(area / ASPECT_RATIO),
    );

    const depths = [...new Set(blocks.map(depthOf))].toSorted((a, b) => a - b);

    const positions = new Map<string, XYPosition>();
    let x = 0;

    for (const level of depths) {
        let y = 0;
        let columnWidth = 0;

        for (const item of blocks) {
            if (depthOf(item) !== level) continue;

            if (y > 0 && y + item.height > maxHeight) {
                x += columnWidth + COLUMN_GAP;
                y = 0;
                columnWidth = 0;
            }

            positions.set(item.id, { x, y });
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
    groups: CanvasGroup[],
    logos: CanvasLogos,
    saved: Positions,
    collapsed: ReadonlySet<string> = new Set(),
) {
    // Uploaded resource icons win; otherwise a matching template logo, then a known image.
    const serviceIcon = (service: CanvasService) =>
        (service.template ? logos[service.template] : undefined) ?? imageIcon(service.image);

    const resourceIcon = (resource: CanvasResource, services: CanvasService[]) =>
        resource.icon ?? services.map(serviceIcon).find(Boolean) ?? engineIcon(resource.engine);

    const folded = foldExporters(graph);
    const byId = new Map(folded.map((node) => [node.id, node]));
    // Exporter resources folded into their database's card have no node of their own.
    const hidden = new Set(graph.flatMap((node) => (byId.has(node.id) ? [] : [node.id])));

    const items = resources.flatMap((resource): Item[] => {
        if (hidden.has(resource.id)) return [];

        const entry = byId.get(resource.id);

        const alone = { resource, entry, width: CARD_WIDTH, height: VOLUME_CARD_HEIGHT };
        const services = entry?.services ?? [];

        // Every service is a card of its own; a database's exporters were folded into its server.
        const serviceCards =
            services.length > 1
                ? services.map((service) => ({
                      id: serviceNodeId(resource.id, service.name),
                      resource,
                      entry,
                      service,
                      width: CARD_WIDTH,
                      height: cardHeight(service),
                  }))
                : [
                      {
                          id: resource.id,
                          resource,
                          entry,
                          service: services[0],
                          width: CARD_WIDTH,
                          height: cardHeight(services[0]),
                      },
                  ];

        return [
            ...serviceCards,
            ...(entry?.volumes ?? []).flatMap((volume) =>
                volume.services.length
                    ? []
                    : [{ ...alone, id: volumeNodeId(resource.id, volume.name), volume }],
            ),
            ...(entry?.configs ?? []).flatMap((config) =>
                config.services.length
                    ? []
                    : [{ ...alone, id: configNodeId(resource.id, config.name), config }],
            ),
        ];
    });

    // In resource order, a group taking the spot of its first card; a group nothing is in
    // has no frame, and a resource whose group is unknown stands alone.
    const blocks: Block[] = [];

    // A card of one of several services; outside a group they get their resource's own frame.
    const isService = (other: Item) =>
        other.service !== undefined && other.id !== other.resource.id;

    for (const item of items) {
        const group = groups.find((entry) => entry.id === item.resource.groupId);

        if (!group && isService(item)) {
            if (!blocks.some((block) => block.id === item.resource.id))
                blocks.push(
                    frameBlock(
                        item.resource.id,
                        undefined,
                        items.filter(
                            (other) => other.resource.id === item.resource.id && isService(other),
                        ),
                    ),
                );
        } else if (!group) blocks.push(loneBlock(item));
        else if (!blocks.some((block) => block.id === group.id))
            blocks.push(
                frameBlock(
                    group.id,
                    group,
                    items.filter((other) => other.resource.groupId === group.id),
                ),
            );
    }

    const depth = columns(folded);

    const auto = autoLayout(blocks, (block) =>
        Math.min(...block.cards.map(({ item }) => depth.get(item.resource.id) ?? 0)),
    );

    const spots = new Map(
        blocks.flatMap((block) => {
            const origin = auto.get(block.id) ?? { x: 0, y: 0 };

            return block.cards.map(
                ({ item, rect }) =>
                    [item.id, { x: origin.x + rect.x, y: origin.y + rect.y }] as const,
            );
        }),
    );

    // Where a card was saved under an older layout: a lone service under its service id, and
    // a resource's one card, now split per service, anchoring its services' auto layout.
    const legacySpot = (item: Item): XYPosition | undefined => {
        if (!item.service) return undefined;

        if (item.id === item.resource.id)
            return saved[serviceNodeId(item.resource.id, item.service.name)];

        const anchor = saved[item.resource.id];
        const first = item.entry?.services[0];
        const from = first && spots.get(serviceNodeId(item.resource.id, first.name));
        const to = spots.get(item.id);

        return anchor && from && to
            ? { x: anchor.x + to.x - from.x, y: anchor.y + to.y - from.y }
            : undefined;
    };

    const frames: CanvasNode[] = [];
    const cards: CanvasNode[] = [];

    for (const block of blocks) {
        const isCollapsed = block.framed && collapsed.has(block.id);

        const members = block.cards.map(({ item, rect }): CanvasNode => {
            const { resource, entry, service } = item;
            const own = !item.volume && !item.config;
            const shared = item.id !== resource.id && service !== undefined;

            return {
                id: item.id,
                type: "card",
                position: saved[item.id] ??
                    legacySpot(item) ??
                    spots.get(item.id) ?? { x: 0, y: 0 },
                width: rect.width,
                height: rect.height,
                zIndex: 1,
                // Hidden cards keep their positions, so showing the contents restores the layout.
                hidden: isCollapsed,
                data: {
                    resource,
                    service,
                    shared,
                    icon:
                        shared && service
                            ? (serviceIcon(service) ?? null)
                            : own
                              ? resourceIcon(resource, service ? [service] : [])
                              : null,
                    draftOnly: entry?.draftOnly ?? false,
                    parseError: own && (entry?.parseError ?? false),
                    groupId: block.group?.id,
                    frameId: block.framed ? block.id : undefined,
                    volume: item.volume,
                    config: item.config,
                },
            };
        });

        cards.push(...members);

        const first = block.cards[0]?.item;

        if (!block.framed || !first) continue;

        const frame = frameRect(members.map(nodeRect));

        const shown = block.cards.flatMap(({ item }) =>
            item.volume || item.config
                ? []
                : [
                      {
                          id: item.id,
                          resourceId: item.resource.id,
                          name:
                              item.id !== item.resource.id && item.service
                                  ? item.service.name
                                  : item.resource.name,
                          icon: resourceIcon(item.resource, item.service ? [item.service] : []),
                      },
                  ],
        );

        // Frames sit behind every card and edge, like Railway's; a collapsed one is a card itself.
        frames.push({
            id: block.id,
            type: "stack",
            position: { x: frame.x, y: frame.y },
            width: isCollapsed ? COLLAPSED_WIDTH : frame.width,
            height: isCollapsed ? COLLAPSED_HEIGHT : frame.height,
            zIndex: isCollapsed ? 1 : -1,
            data: {
                group: block.group,
                name: block.group?.name ?? first.resource.name,
                projectId: first.resource.projectId,
                collapsed: isCollapsed,
                resources: shown,
                icon: block.group
                    ? (block.group.icon ?? null)
                    : resourceIcon(first.resource, first.entry?.services ?? []),
                dropTarget: false,
            },
        });
    }

    const nodes = [...frames, ...cards];

    return { nodes, edges: buildEdges(nodes, graph) };
}

/** Reference edges between cards, attached to the sides of each pair that face each other. */
export function buildEdges(nodes: CanvasNode[], graph: CanvasGraph) {
    const rects = new Map(
        nodes.flatMap((node) => (node.hidden ? [] : [[node.id, nodeRect(node)] as const])),
    );

    // A card hidden in a collapsed frame hands its references to the frame.
    const frameOf = new Map(
        nodes.flatMap((node) =>
            node.type === "card" && node.data.frameId
                ? [[node.id, node.data.frameId] as const]
                : [],
        ),
    );

    const shown = (id: string) => (rects.has(id) ? id : frameOf.get(id));

    // References belong to a resource; one split into service cards draws them from its first.
    const cardOf = (entry: CanvasGraph[number] | undefined, resourceId: string) =>
        entry && entry.services.length > 1 && entry.services[0]
            ? serviceNodeId(resourceId, entry.services[0].name)
            : resourceId;

    // Folded here because the cards were: an exporter is a tray, not a service card to point at.
    const folded = foldExporters(graph);
    const byId = new Map(folded.map((entry) => [entry.id, entry]));
    const edges = new Map<string, Edge>();

    const connect = (kind: string, sourceId: string, targetId: string) => {
        const source = shown(sourceId);
        const target = shown(targetId);
        const from = source && rects.get(source);
        const to = target && rects.get(target);

        if (!source || !target || !from || !to || source === target) return;

        const id = `${kind}:${source}:${target}`;

        edges.set(id, { id, source, target, ...facingHandles(from, to) });
    };

    for (const entry of folded) {
        for (const reference of entry.references)
            connect("reference", cardOf(entry, entry.id), cardOf(byId.get(reference), reference));

        if (entry.services.length > 1)
            for (const service of entry.services)
                for (const dependency of service.dependsOn)
                    connect(
                        "depends",
                        serviceNodeId(entry.id, service.name),
                        serviceNodeId(entry.id, dependency),
                    );
    }

    return [...edges.values()];
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

/** A service a volume can be mounted into, labelled the way the canvas names its card. */
export type VolumeTarget = {
    resourceId: string;
    service: string;
    label: string;
    /** The icon the service's card shows, if it has one. */
    icon: string | null;
};

/** Every service of the Compose resources whose spec can be read; buckets and broken specs have none. */
export function volumeTargets(
    resources: CanvasResource[],
    graph: CanvasGraph,
    logos: CanvasLogos,
): VolumeTarget[] {
    return resources.flatMap((resource) => {
        const entry = graph.find((item) => item.id === resource.id);

        if (!entry || entry.parseError) return [];

        return entry.services.map((service) => {
            const own =
                (service.template ? logos[service.template] : undefined) ??
                imageIcon(service.image);

            return {
                resourceId: resource.id,
                service: service.name,
                icon: (entry.services.length === 1 ? resource.icon : null) ?? own ?? null,
                // A lone service is the resource, so it carries the resource's name.
                label:
                    entry.services.length === 1
                        ? resource.name
                        : `${resource.name} / ${service.name}`,
            };
        });
    });
}
