import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import evlog from "evlog/vite";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vite-plus";
import { monitoringWorker } from "./worker-plugin";

const require = createRequire(import.meta.url);

// Tests live in /tests/web, outside this package, so bare imports of web-only
// deps must resolve to the same copy that components under src/ use.
const svelteQuery = dirname(require.resolve("@tanstack/svelte-query/package.json"));

export default defineConfig({
    test: {
        include: ["../../tests/web/**/*.test.ts"],
    },
    resolve: {
        alias: [{ find: /^@tanstack\/svelte-query$/, replacement: svelteQuery }],
    },
    // effect-mq (via @stoat/workflows) needs drizzle v1 while the rest uses 0.45.2.
    // Externalized, the bare import resolves to the hoisted 0.45.2 at runtime and crashes.
    ssr: { noExternal: ["drizzle-orm"] },
    plugins: [
        monitoringWorker(),
        varlockVitePlugin({ ssrInjectMode: "auto-load" }),
        tailwindcss(),
        sveltekit(),
        evlog({ service: "stoat-web" }),
    ],
});
