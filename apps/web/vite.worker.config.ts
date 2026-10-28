import { varlockVitePlugin } from "@varlock/vite-integration";
import { defineConfig } from "vite-plus";
import pkg from "./package.json" with { type: "json" };

// Bundles the standalone worker (src/worker.ts). Vite is needed for the `?raw` template import,
// the TypeScript workspace packages and the drizzle split (see ssr.noExternal in vite.config.ts).
export default defineConfig({
    // Like adapter-node: only this app's dependencies exist at runtime, so bundle everything else.
    // Workspace packages ship TypeScript source, so they are bundled too.
    ssr: {
        noExternal: true,
        external: Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@stoat/")),
    },
    plugins: [varlockVitePlugin({ ssrInjectMode: "auto-load" })],
    build: {
        ssr: "src/worker.ts",
        // Separate from build/, which adapter-node wipes on every web build.
        outDir: "build-worker",
        emptyOutDir: true,
    },
});
