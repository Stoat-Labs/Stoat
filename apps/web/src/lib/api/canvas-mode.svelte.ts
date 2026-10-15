import { page } from "$app/state";
import { createQuery } from "@tanstack/svelte-query";
import { orpc } from "./orpc";

// Seeded from the layout load; the query keeps it fresh after the flag is toggled,
// without a SvelteKit invalidation (which would reset shallow search params).
export function createCanvasModeQuery() {
    return createQuery(() =>
        orpc.userSettings.get.queryOptions({
            initialData: { canvasMode: page.data.canvasMode },
        }),
    );
}

export function projectHref(projectId: string, canvasMode: boolean) {
    return canvasMode ? `/projects/${projectId}/canvas` : `/projects/${projectId}`;
}
