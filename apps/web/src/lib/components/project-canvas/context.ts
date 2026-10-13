import { createContext } from "svelte";

/** Shared clock so every card's "deployed 3m ago" ticks together. */
export const [getCanvasClock, setCanvasClock] = createContext<{ now: number }>();
