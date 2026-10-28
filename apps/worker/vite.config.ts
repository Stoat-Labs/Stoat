import { defineConfig } from "vite-plus";

// One self-contained file: the image ships Node, git and this bundle, no node_modules.
// Vite is needed for the `?raw` template import, the TypeScript workspace packages and the
// two drizzle-orm versions, which only resolve correctly at build time.
export default defineConfig({
    ssr: { noExternal: true, target: "node" },
    build: {
        ssr: "src/index.ts",
        outDir: "dist",
        emptyOutDir: true,
        minify: true,
        rollupOptions: { output: { entryFileNames: "worker.mjs", codeSplitting: false } },
    },
});
