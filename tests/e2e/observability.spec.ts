import { expect, test, type Page } from "@playwright/test";
import { MACHINE } from "./fake-sidecar";
import { ids, resetSidecar, rpc, sql } from "./fixtures";

const views = ["", "/health", "/http", "/dns", "/services"];

/** Opens a page and returns every failed request and uncaught error it caused. */
async function problemsOn(page: Page, path: string) {
    const problems: string[] = [];

    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("response", (response) => {
        if (response.status() >= 400)
            problems.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    });
    await page.goto(path);
    await expect(page.locator("phantom-ui[loading]")).toHaveCount(0, { timeout: 15_000 });

    return problems;
}

/** A cluster on the fake sidecar whose monitoring stack is initialized and ready. */
async function monitoredCluster(page: Page) {
    // Another cluster's monitoring services on the shared fake would block this one.
    await resetSidecar();
    await page.goto("/observability");

    const { id } = await rpc(page, "cluster/createCluster", {
        name: `Monitored ${Date.now()}`,
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    await rpc(page, "cluster/initializeCluster", {
        clusterId: id,
        configuration: { machine: MACHINE.name, retentionDays: 7 },
    });
    await expect
        .poll(
            async () =>
                (
                    await sql<{ status: string }>(
                        "SELECT initialization_status AS status FROM clusters WHERE id = $1",
                        [id],
                    )
                )[0]?.status,
            { timeout: 120_000 },
        )
        .toBe("ready");

    return id;
}

test("without a selection it opens on a cluster", async ({ page }) => {
    await page.goto("/observability");
    await expect(page.getByRole("button", { name: /^Clusters: \S/u })).toBeVisible();
});

test("a cluster without monitoring says how to start collecting", async ({ page }) => {
    await page.goto(`/observability?clusters=${ids.lonelyCluster}`);

    const notice = page
        .getByRole("alert")
        .filter({ hasText: "Initialize monitoring to collect metrics." });

    await expect(notice).toBeVisible();
    await notice.getByRole("link", { name: "Open cluster" }).click();
    await expect(page).toHaveURL(new RegExp(`/clusters/${ids.lonelyCluster}$`, "u"));
});

test.describe("with monitoring", () => {
    test.setTimeout(3 * 60_000);

    test("every view loads, empty, without errors", async ({ page }) => {
        const clusterId = await monitoredCluster(page);

        for (const view of views) {
            const problems = await problemsOn(page, `/observability${view}?clusters=${clusterId}`);
            expect(problems, view || "overview").toEqual([]);
            await expect(page.getByText("Initialize monitoring to collect metrics.")).toHaveCount(
                0,
            );
        }
    });

    test("a stack that stops answering is reported without breaking the page", async ({ page }) => {
        const clusterId = await monitoredCluster(page);
        await sql("UPDATE clusters SET sidecar_url = 'http://127.0.0.1:9' WHERE id = $1", [
            clusterId,
        ]);

        await page.goto(`/observability?clusters=${clusterId}`);
        await expect(
            page.getByText("Monitoring is unreachable. Other clusters remain available."),
        ).toBeVisible({ timeout: 45_000 });
    });
});

test("the admin area links to system settings", async ({ page }) => {
    await page.goto("/admin");
    await page
        .getByRole("link", { name: /settings/iu })
        .first()
        .click();
    await expect(page).toHaveURL(/\/admin\/settings$/u);
    await expect(page.getByText("General settings")).toBeVisible();
});
