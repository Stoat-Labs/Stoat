import { browser } from "$app/environment";

/** A width in pixels, or the whole canvas. */
export type PanelWidth = number | "full";

export const minPanelWidth = 480;

// The panel holds at its minimum until the pointer goes this much further, so it never closes by accident.
export const panelCloseOvershoot = 120;

// Dragging until less than this much canvas is left beside the panel fills the canvas with it.
export const fullPanelGap = 240;

// How much further back the pointer has to go before a full-screen panel shrinks again.
export const panelSnapSlack = 80;

export function readPanelWidth(): PanelWidth | undefined {
    if (!browser) return undefined;
    const value = document.cookie.match(/(?:^|; )canvas_panel_width=(\w+)/)?.[1];

    if (value === "full") return value;
    const width = Number(value);

    return width > 0 ? width : undefined;
}

export function savePanelWidth(width: PanelWidth) {
    const value = width === "full" ? width : Math.round(width);
    document.cookie = `canvas_panel_width=${value}; path=/; max-age=31536000; samesite=lax`;
}
