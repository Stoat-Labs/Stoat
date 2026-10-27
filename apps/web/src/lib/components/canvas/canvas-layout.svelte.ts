import { client, orpc, queryClient } from "$lib/api/orpc";

import { savePositions, type Positions } from "./graph";

/**
 * The project's card positions with Railway's undo/redo, where each entry is a whole snapshot.
 * The layout is shared by the project, so it is saved to the server; a burst of drags and undos
 * collapses into one write of the latest snapshot.
 */
export class CanvasLayout {
    positions = $state.raw<Positions>({});

    #past = $state.raw<Positions[]>([]);

    #future = $state.raw<Positions[]>([]);

    #pending: Positions | undefined;

    #timer: ReturnType<typeof setTimeout> | undefined;

    #projectId: () => string;

    constructor(projectId: () => string) {
        this.#projectId = projectId;
    }

    get canUndo() {
        return this.#past.length > 0;
    }

    get canRedo() {
        return this.#future.length > 0;
    }

    /** Shows a saved layout, like on a project switch: no undo step and nothing to save. */
    load(next: Positions) {
        this.positions = next;
    }

    /** Saves a layout change that is not an undo step of its own, like a card following a move. */
    place(next: Positions) {
        this.positions = next;
        this.#persist(next);
    }

    commit(next: Positions) {
        this.#past = [...this.#past.slice(-49), this.positions];
        this.#future = [];
        this.place(next);
    }

    undo() {
        const previous = this.#past.at(-1);

        if (!previous) return;

        this.#past = this.#past.slice(0, -1);
        this.#future = [this.positions, ...this.#future];
        this.place(previous);
    }

    redo() {
        const [next, ...rest] = this.#future;

        if (!next) return;

        this.#future = rest;
        this.#past = [...this.#past, this.positions];
        this.place(next);
    }

    /** Writes the pending snapshot now, as the canvas unmounts. */
    flush() {
        clearTimeout(this.#timer);

        if (!this.#pending) return;

        const saved = this.#pending;
        const savedFor = this.#projectId();

        this.#pending = undefined;

        client.projects
            .setCanvasLayout({ projectId: savedFor, layout: saved })
            .then(() => {
                // A later visit must not paint the older layout from the cache.
                queryClient.setQueryData(
                    orpc.projects.getProject.queryKey({ input: { projectId: savedFor } }),
                    (project) => project && { ...project, canvasLayout: saved },
                );
            })
            .catch(() => {
                // An unsaved layout only resets on the next visit.
            });
    }

    #persist(next: Positions) {
        savePositions(this.#projectId(), next);
        this.#pending = next;
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.flush(), 500);
    }
}
