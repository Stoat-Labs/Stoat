import { cubicOut } from "svelte/easing";
import { prefersReducedMotion, Tween } from "svelte/motion";
import {
    fullPanelGap,
    minPanelWidth,
    panelCloseOvershoot,
    panelSnapSlack,
    readPanelWidth,
    savePanelWidth,
} from "./panel-width";

/**
 * How wide the canvas's docked details panel is: Railway's stepped defaults, the width the user
 * dragged it to, or the whole canvas. Create it while a component initialises.
 */
export class PanelSize {
    /** Bound to the canvas element's width. */
    canvasWidth = $state(0);

    /** Bound to the canvas element, which the drag measures against. */
    canvasElement = $state<HTMLDivElement>();

    resizing = $state(false);

    // The width the user dragged the panel to, kept in a cookie.
    private chosen = $state(readPanelWidth());

    // Narrow screens hide the graph and give the panel the whole canvas.
    narrow = $derived(this.canvasWidth < 900);

    // Wider canvases step the docked panel up to a fixed width, as Railway does: 70% to 1150px, then 904, 1008 and 1184px.
    private defaultWidth = $derived.by(() => {
        if (this.canvasWidth < 1150) return Math.round(this.canvasWidth * 0.7);

        if (this.canvasWidth < 1400) return 904;

        if (this.canvasWidth < 1700) return 1008;

        return 1184;
    });

    private target = $derived.by(() => {
        if (this.narrow) return this.canvasWidth;

        if (this.chosen === "full") return this.canvasWidth;

        // A width saved on a wider window still leaves some canvas beside the panel.
        return Math.min(
            Math.max(this.chosen ?? this.defaultWidth, minPanelWidth),
            this.canvasWidth - fullPanelGap,
        );
    });

    private tween = new Tween(0, { easing: cubicOut });

    width = $derived(this.tween.current);

    full = $derived(this.narrow || this.chosen === "full");

    /** @param close Called when the panel is dragged shut. */
    constructor(private close: () => void) {
        // Starts from the saved state, so a saved full-screen panel does not animate in on page load.
        let wasFull = this.chosen === "full";

        // Only snapping to or from full screen animates; dragging and window resizes follow at once.
        $effect.pre(() => {
            const full = this.chosen === "full";
            const snapped = full !== wasFull;
            wasFull = full;

            void this.tween.set(this.target, {
                duration: snapped && !prefersReducedMotion.current ? 300 : 0,
            });
        });
    }

    startResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
        if (event.button !== 0) return;

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        this.resizing = true;
    };

    resize = (event: PointerEvent) => {
        if (!this.resizing || !this.canvasElement) return;

        const width = this.canvasElement.getBoundingClientRect().right - event.clientX;

        // Pulling well past the minimum closes the panel, like collapsing a sidebar; its saved width stays.
        if (width < minPanelWidth - panelCloseOvershoot) {
            this.resizing = false;
            this.chosen = readPanelWidth();
            this.close();

            return;
        }

        // Leaving full screen takes a further pull, so hovering at the threshold does not flicker between the two.
        const fullAt =
            this.canvasWidth - fullPanelGap - (this.chosen === "full" ? panelSnapSlack : 0);

        this.chosen = width > fullAt ? "full" : Math.max(width, minPanelWidth);
    };

    endResize = () => {
        if (!this.resizing) return;

        this.resizing = false;

        if (this.chosen) savePanelWidth(this.chosen);
    };
}
