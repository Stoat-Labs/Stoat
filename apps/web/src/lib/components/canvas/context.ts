import { createContext } from "svelte";

/** Shared clock so every card's "deployed 3m ago" ticks together. */
export const [getCanvasClock, setCanvasClock] = createContext<{ now: number }>();

/** What a frame's ⋮ menu can do; nodes are rendered by Svelte Flow, so this comes via context. */
export type GroupAction = "rename" | "icon-upload" | "icon-link";

export const [getCanvasActions, setCanvasActions] = createContext<{
    edit: (action: GroupAction, resourceId: string) => void;
    toggleCollapsed: (resourceId: string) => void;
    isCollapsed: (resourceId: string) => boolean;
    /** Asks to delete a whole resource; the canvas confirms it first. */
    remove: (resourceId: string) => void;
    /** Railway's "Group ›": moves a service card into another group, or out into its own (null). */
    regroup: (nodeId: string, toResourceId: string | null) => void;
    /** Railway's "Remove Group": every service but the first moves out into a resource of its own. */
    ungroup: (resourceId: string) => void;
}>();
