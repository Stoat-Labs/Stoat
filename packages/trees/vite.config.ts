import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite-plus";

export default defineConfig({
    plugins: [svelte()],
    resolve: { conditions: ["browser"] },
    test: {
        include: ["../../tests/trees/**/*.test.ts"],
        environment: "jsdom",
    },
});
