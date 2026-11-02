import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite-plus";

export default defineConfig({
    plugins: [svelte()],
    resolve: { conditions: ["browser"] },
    test: {
        // Vitest v4 compatibility: preserve mock call history.
        // Remove after tests no longer rely on calls from setup or earlier tests.
        // https://viteplus.dev/guide/vitest-v5#remove-unneeded-compatibility-settings
        // https://vitest.dev/guide/migration/#clearmocks-is-enabled-by-default
        clearMocks: false,
        include: ["../../tests/trees/**/*.test.ts"],
        environment: "jsdom",
    },
});
