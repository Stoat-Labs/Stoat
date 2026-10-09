import { expect, test, type Page } from "@playwright/test";
import { MACHINE } from "./fake-sidecar";
import { ids, memberStorageState, receivedComposes, resetSidecar, rpc, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog").or(page.getByRole("alertdialog"));

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "breadcrumb" });

let clusters = 0;

/** A cluster on the fake sidecar with a name no other test uses. */
async function createCluster(page: Page, sidecarUrl = process.env.E2E_SIDECAR_URL!) {
    clusters += 1;
    const name = `Cluster ${Date.now()}-${clusters}`;

    const { id } = await rpc(page, "cluster/createCluster", {
        name,
        sidecarUrl,
        sidecarToken: "e2e-token",
    });

    return { id, name };
}

test.beforeEach(async () => {
    await resetSidecar();
});

test("an admin creates a cluster in a dialog, sees it healthy, and deletes it", async ({
    page,
}) => {
    const name = `Created ${Date.now()}`;
    await page.goto("/clusters");
    await page.getByRole("button", { name: "Create cluster" }).click();

    const create = dialog(page);
    await expect(create.getByRole("button", { name: "Create Cluster" })).toBeDisabled();
    await create.getByLabel("Name").fill(name);
    await create.getByLabel("Sidecar URL").fill(process.env.E2E_SIDECAR_URL!);
    await create.getByLabel("Sidecar token").fill("e2e-token");
    await create.getByRole("button", { name: "Create Cluster" }).click();
    await expect(create).toHaveCount(0);

    await expect(row(page, name)).toContainText("Healthy");
    await expect(row(page, name)).toContainText("0");

    // The token never comes back to the browser.
    const listing = await page.request.post("/rpc/cluster/listClusters", {
        data: { json: {} },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    expect(await listing.text()).not.toContain("e2e-token");

    await row(page, name).getByRole("link", { name }).click();
    await expect(breadcrumb(page)).toContainText(name);
    await expect(page.getByText(MACHINE.name).first()).toBeVisible();

    await page.goto("/clusters");
    await row(page, name)
        .getByRole("button", { name: `Actions for ${name}` })
        .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(dialog(page)).toContainText(`"${name}" will be permanently deleted`);
    await dialog(page).getByRole("button", { name: "Delete" }).click();
    // The modal hides the table from the accessibility tree, so wait for it to close first.
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, name)).toHaveCount(0);
    expect(await sql("SELECT id FROM clusters WHERE name = $1", [name])).toEqual([]);
});

test("searching narrows the list", async ({ page }) => {
    await page.goto("/clusters");
    await page.getByLabel("Search clusters").fill("lonel");
    await expect(page).toHaveURL(/q=lonel/u);
    await expect(page.getByRole("link", { name: "Lonely" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Main" })).toHaveCount(0);

    await page.getByLabel("Search clusters").fill("nothing-matches-this");
    await expect(page.getByText("No matching clusters")).toBeVisible();
});

test("deleting a cluster removes its projects", async ({ page }) => {
    await page.goto("/clusters");
    const cluster = await createCluster(page);
    await rpc(page, "projects/createProject", { name: "Doomed", clusterId: cluster.id });
    await page.reload();

    await expect(row(page, cluster.name)).toContainText("1");
    await row(page, cluster.name)
        .getByRole("button", { name: `Actions for ${cluster.name}` })
        .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(dialog(page)).toContainText("Its 1 project will also be removed.");
    await dialog(page).getByRole("button", { name: "Delete" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, cluster.name)).toHaveCount(0);
    expect(await sql("SELECT id FROM projects WHERE cluster_id = $1", [cluster.id])).toEqual([]);
});

test("a cluster whose projects hold buckets is kept", async ({ page }) => {
    await page.goto("/clusters");
    await row(page, "Main").getByRole("button", { name: "Actions for Main" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await dialog(page).getByRole("button", { name: "Delete" }).click();

    await expect(dialog(page)).toContainText("Delete the S3 buckets");
    expect(await sql("SELECT id FROM clusters WHERE id = $1", [ids.mainCluster])).toHaveLength(1);
});

test("an unreachable sidecar shows as unknown instead of breaking the page", async ({ page }) => {
    await page.goto("/clusters");
    // Nothing listens on port 9 (discard) here.
    const cluster = await createCluster(page, "http://127.0.0.1:9");
    await page.reload();

    await expect(row(page, cluster.name)).toContainText("Unknown");
    await page.goto(`/clusters/${cluster.id}`);
    await expect(page.getByText("Diagnostics unavailable")).toBeVisible();

    // The home page checks each cluster's health; an unreachable one is no server error.
    const health = page.waitForResponse(
        (response) =>
            response.url().includes("/rpc/cluster/healthz") &&
            (response.request().postData() ?? "").includes(cluster.id),
    );

    await page.goto("/");
    expect((await health).status()).toBe(200);
});

test.describe("monitoring", () => {
    test.setTimeout(3 * 60_000);

    test("initializing deploys the stack and becomes ready", async ({ page }) => {
        await page.goto("/clusters");
        const cluster = await createCluster(page);
        await page.goto(`/clusters/${cluster.id}`);

        await page.getByRole("button", { name: "Initialize monitoring" }).click();
        const init = dialog(page);
        await init.getByRole("combobox", { name: "Select deployment machine" }).click();
        await page.getByRole("option", { name: new RegExp(MACHINE.name, "u") }).click();
        await init.getByLabel("Retention period").fill("14");
        await init.getByRole("button", { name: "Initialize monitoring" }).click();

        // The initialization's own deployment page follows it to the end.
        await expect(page.getByRole("heading", { name: "Cluster initialization" })).toBeVisible();
        await expect(page.getByRole("status").first()).toHaveText("Ready", { timeout: 120_000 });
        await expect(page.getByText("Ingestion verified on 1 machine(s)")).toBeVisible();

        await page.goto(`/clusters/${cluster.id}`);
        await expect(page.getByText(/^Initialized /u)).toBeVisible();
        await expect(page.getByText("14 days")).toBeVisible();
        await expect(
            page.getByRole("link", { name: `Open ${cluster.name}-internal` }),
        ).toBeVisible();

        // GreptimeDB first, on its own; then the whole stack with the collectors.
        const composes = await receivedComposes();
        expect(composes).toHaveLength(2);
        expect(composes[1]).toContain("alloy");

        const [row] = await sql<{ status: string }>(
            "SELECT initialization_status AS status FROM clusters WHERE id = $1",
            [cluster.id],
        );

        expect(row?.status).toBe("ready");
    });

    test("a sidecar that cannot be reached explains why it cannot initialize", async ({ page }) => {
        await page.goto("/clusters");
        const cluster = await createCluster(page, "http://127.0.0.1:9");
        await page.goto(`/clusters/${cluster.id}`);
        await page.getByRole("button", { name: "Initialize monitoring" }).click();

        await expect(dialog(page).getByRole("alert")).toBeVisible();
        await expect(
            dialog(page).getByRole("button", { name: "Initialize monitoring" }),
        ).toHaveCount(0);
    });
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("clusters are visible but cannot be created or deleted", async ({ page }) => {
        await page.goto("/clusters");
        await expect(page.getByRole("link", { name: "Main" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Create cluster" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Actions for Main" })).toHaveCount(0);

        for (const [path, input] of [
            ["cluster/createCluster", { name: "x", sidecarUrl: "http://x", sidecarToken: "x" }],
            ["cluster/deleteCluster", { clusterId: ids.lonelyCluster }],
        ] as const) {
            const response = await page.request.post(`/rpc/${path}`, {
                data: { json: input },
                headers: { origin: process.env.E2E_BASE_URL! },
            });

            expect(response.status()).toBe(403);
        }
    });

    test("monitoring cannot be initialized", async ({ page }) => {
        await page.goto(`/clusters/${ids.lonelyCluster}`);
        await expect(breadcrumb(page)).toContainText("Lonely");
        await expect(page.getByRole("button", { name: "Initialize monitoring" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Reinitialize" })).toHaveCount(0);
    });
});
