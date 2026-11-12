import { createContext } from "svelte";

/** Shared clock so every card's "deployed 3m ago" ticks together. */
export const [getCanvasClock, setCanvasClock] = createContext<{ now: number }>();

/**
 * Dialogs the canvas menus open. Rename and the icons act on a group; the rest on a resource,
 * where "new-group" starts a group around it.
 */
export type GroupAction =
    | "rename"
    | "icon-upload"
    | "icon-link"
    | "new-group"
    | "move-service"
    | "move"
    | "copy"
    | "duplicate";

export const [getCanvasActions, setCanvasActions] = createContext<{
    /** Opens a dialog for a group (rename, icons) or a resource (everything else). */
    edit: (action: GroupAction, id: string) => void;
    /** Saves a name typed inline on a card. */
    rename: (resourceId: string, name: string) => Promise<void>;
    toggleCollapsed: (resourceId: string) => void;
    isCollapsed: (resourceId: string) => boolean;
    /** Stages a whole resource for deletion; applying the staged changes removes it. */
    remove: (resourceId: string) => void;
    /** Undoes a staged deletion. */
    restore: (resourceId: string) => void;
    isPendingDelete: (resourceId: string) => boolean;
    /** Asks to roll out a resource again even if nothing changed; the canvas confirms it first. */
    redeploy: (resourceId: string) => void;
    /** Staged edits would ship with a redeploy, so it is only offered without any. */
    canRedeploy: (resourceId: string) => boolean;
    /** Stops (the canvas confirms it first) or starts a resource's containers in place. */
    setRunning: (resourceId: string, running: boolean) => void;
    /** Undefined when there is nothing deployed to stop or start, like a bucket or a draft. */
    runState: (resourceId: string) => "running" | "stopped" | undefined;
    /** Railway's "Group ›": puts a resource's card into a group's frame, or out of any (null). */
    setGroup: (resourceId: string, groupId: string | null) => void;
    /** Opens the panel on one service of a resource with several. */
    selectService: (resourceId: string, service: string) => void;
    /** Opens a volume's pane, from the tray under the service that mounts it. */
    selectVolume: (resourceId: string, volume: string) => void;
    /** Asks to delete a volume; the canvas confirms it first. */
    removeVolume: (nodeId: string) => void;
    /** Railway's "Disconnect volume": unmounts it from its service, and it stays on the canvas. */
    disconnectVolume: (nodeId: string) => void;
    isVolumeMounted: (nodeId: string) => boolean;
    /** Opens a card on one tab: Metrics from an exporter's tray, Compose from a bind mount's. */
    selectTab: (nodeId: string, tab: "metrics" | "compose") => void;
    /** Opens a config's pane, from its tray or its own card. */
    selectConfig: (resourceId: string, config: string) => void;
    /** Asks to delete a config; the canvas confirms it first. */
    removeConfig: (nodeId: string) => void;
    /** Unmounts a config from every service; it stays on the canvas as a card of its own. */
    disconnectConfig: (nodeId: string) => void;
    isConfigMounted: (nodeId: string) => boolean;
    /** Railway's "Remove Group": the frame goes, its resources stay. */
    ungroup: (groupId: string) => void;
}>();

/** The project's cluster, so cards can ask it how their containers are doing. */
export const [getCanvasCluster, setCanvasCluster] = createContext<{ id: string }>();
