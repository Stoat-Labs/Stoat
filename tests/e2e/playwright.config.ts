import { defineConfig, devices } from "@playwright/test";
import { chromiumExecutable } from "./chromium";
import { storageState } from "./fixtures";

// One shared database and dev server: specs run serially and never retry, so flakes show.
export default defineConfig({
    testDir: ".",
    testMatch: "*.spec.ts",
    outputDir: "../../test-results/e2e/artifacts",
    globalSetup: "./global-setup.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: process.env.CI ? [["list"], ["github"]] : "list",
    use: {
        ...devices["Desktop Chrome"],
        baseURL: process.env.E2E_BASE_URL,
        storageState,
        // The server runs as if behind a proxy; specs that act as other clients override it.
        extraHTTPHeaders: { "x-forwarded-for": "10.255.0.2" },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        // NixOS and other hosts without Playwright's bundled browser can point at their own.
        launchOptions: { executablePath: chromiumExecutable() },
    },
});
