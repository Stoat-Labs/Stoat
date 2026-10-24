import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import evlog from "evlog/vite";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vite-plus";
import { rpcSocket } from "./rpc-socket-plugin";
import { monitoringWorker } from "./worker-plugin";
import pkg from "../../package.json" with { type: "json" };

const require = createRequire(import.meta.url);

// Tests live in /tests/web, outside this package, so bare imports of web-only
// deps must resolve to the same copy that components under src/ use.
const svelteQuery = dirname(require.resolve("@tanstack/svelte-query/package.json"));

// CI passes APP_VERSION (plus GIT_COMMIT for canaries) as Docker build args.
// Anything else is a dev build, tagged with the local commit when git is around.
const devCommit = () => {
    try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
    } catch {
        return null;
    }
};

const appVersion = process.env.APP_VERSION ?? `${pkg.version}-dev`;

const gitCommit = process.env.APP_VERSION
    ? process.env.GIT_COMMIT?.slice(0, 7) || null
    : devCommit();

export default defineConfig({
    test: {
        include: ["../../tests/web/**/*.test.ts"],
    },
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __GIT_COMMIT__: JSON.stringify(gitCommit),
    },
    resolve: {
        alias: [{ find: /^@tanstack\/svelte-query$/, replacement: svelteQuery }],
    },
    // effect-mq (via @stoat/workflows) needs drizzle v1 while the rest uses 0.45.2.
    // Externalized, the bare import resolves to the hoisted 0.45.2 at runtime and crashes.
    ssr: { noExternal: ["drizzle-orm"] },
    plugins: [
        monitoringWorker(),
        rpcSocket(),
        varlockVitePlugin({ ssrInjectMode: "auto-load" }),
        tailwindcss(),
        sveltekit(),
        evlog({ service: "stoat-web" }),
    ],
});
