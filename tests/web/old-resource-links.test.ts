import { isRedirect } from "@sveltejs/kit";
import { describe, expect, it } from "vite-plus/test";
import { GET } from "../../apps/web/src/routes/(app)/projects/[projectId]/[resourceId]/[...rest]/+server";

/** Where an old resource page link now lands. */
function target(path: string) {
    const url = new URL(path, "http://clowder.test");
    const [, , projectId = "", resourceId = "", ...rest] = url.pathname.split("/");

    try {
        // SAFETY: the handler only reads `params` and `url`.
        GET({ params: { projectId, resourceId, rest: rest.join("/") }, url } as never);
    } catch (error) {
        if (isRedirect(error)) return error.location;
        throw error;
    }

    throw new Error("expected a redirect");
}

describe("old resource links", () => {
    it("open the same deployment in the canvas", () => {
        expect(target("/projects/p/r/deployments/d")).toBe(
            "/projects/p/canvas?node=r&tab=deployments&deployment=d",
        );
    });

    it("keep a saved log range", () => {
        expect(target("/projects/p/r/logs?logStart=a&logEnd=b&other=c")).toBe(
            "/projects/p/canvas?node=r&tab=logs&logStart=a&logEnd=b",
        );
    });
});
