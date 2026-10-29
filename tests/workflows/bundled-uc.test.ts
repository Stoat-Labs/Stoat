import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/** The uc release a Dockerfile downloads, and the hashes it checks it against. */
function pinnedUc(dockerfile: string) {
    const text = readFileSync(dockerfile, "utf8");

    return {
        version: text.match(/^ARG UNCLOUD_VERSION=(\S+)$/mu)?.[1],
        amd64: text.match(/^ARG UC_SHA256_amd64=(\S+)$/mu)?.[1],
        arm64: text.match(/^ARG UC_SHA256_arm64=(\S+)$/mu)?.[1],
    };
}

describe("bundled uc", () => {
    // Either image can run ProvisionCluster, which installs the daemon at the bundled uc's version.
    it("is the sidecar's Uncloud release in both the web and the worker image", () => {
        const goMod = readFileSync("apps/sidecar/go.mod", "utf8");
        const web = pinnedUc("apps/web/Dockerfile");

        expect(web.version).toBe(goMod.match(/github\.com\/psviderski\/uncloud v(\S+)/u)?.[1]);
        expect(web.amd64).toMatch(/^[0-9a-f]{64}$/u);
        expect(pinnedUc("apps/worker/Dockerfile")).toEqual(web);
    });
});
