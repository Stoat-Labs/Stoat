import { defineConfig } from "vite-plus";

// The pre-deploy script as one self-contained file: the image's node_modules hold the workspace
// packages as TypeScript, which Node won't run from there.
export default defineConfig({
    ssr: { noExternal: true, target: "node" },
    build: {
        ssr: "scripts/rebrand.ts",
        outDir: "build-scripts",
        emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: "rebrand.mjs", codeSplitting: false } },
    },
});
