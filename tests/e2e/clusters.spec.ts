import { expect, test, type Page } from "@playwright/test";
import { MACHINE, SIDECAR_DOMAIN } from "./fake-sidecar";
import { ids, receivedComposes, resetSidecar, rpc, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog").or(page.getByRole("alertdialog"));

const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "breadcrumb" });

const domainCard = (page: Page) =>
    page
        .locator("[data-slot=frame]")
        .filter({ has: page.locator("[data-slot=frame-panel-title]", { hasText: /^Domain$/u }) });

/** Opens the delete confirmation from a cluster row's actions menu. */
async function askDelete(page: Page, name: string) {
    await row(page, name)
        .getByRole("button", { name: `Actions for ${name}` })
        .click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
}

/** A machine the fake sidecar reports next to MACHINE until it's removed or reset. */
const WORKER = { id: "0f".repeat(16), name: "e2e-worker", state: "Down" };

async function addWorker() {
    await fetch(`${process.env.E2E_SIDECAR_URL}/__machines`, {
        method: "POST",
        body: JSON.stringify(WORKER),
    });
}

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
    await page.getByRole("menuitem", { name: "Connect existing" }).click();

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
    const listing = await page.request.post("/rpc/api/cluster/listClusters", {
        data: {},
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    expect(await listing.text()).not.toContain("e2e-token");

    await row(page, name).getByRole("link", { name }).click();
    await expect(breadcrumb(page)).toContainText(name);
    await expect(page.getByText(MACHINE.name).first()).toBeVisible();

    await page.goto("/clusters");
    await askDelete(page, name);
    await expect(dialog(page)).toContainText(`"${name}" will be permanently deleted`);
    await dialog(page).getByRole("button", { name: "Delete" }).click();
    // The modal hides the table from the accessibility tree, so wait for it to close first.
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, name)).toHaveCount(0);
    expect(await sql("SELECT id FROM clusters WHERE name = $1", [name])).toEqual([]);
});

test("an admin sets up a server over SSH, follows it on its deployment page, retries, and deletes the cluster", async ({
    page,
}) => {
    test.setTimeout(3 * 60_000);
    const name = `Server ${Date.now()}`;
    await page.goto("/clusters");
    await page.getByRole("button", { name: "Create cluster" }).click();
    await page.getByRole("menuitem", { name: "New cluster" }).click();

    const create = dialog(page);
    await create.getByLabel("Name").fill(name);
    // .invalid names never resolve, so the setup fails without touching a real server.
    await create.getByLabel("Server address").fill("server.invalid");
    await create
        .getByRole("checkbox", { name: "Share Caddy's certificates across machines" })
        .check();
    await create.getByRole("button", { name: "Continue" }).click();

    const setup = page.getByRole("dialog", { name: new RegExp(name) });
    await expect(setup.getByRole("textbox", { name: "Public key" })).toHaveValue(
        /^ssh-ed25519 \S+ stoat-/,
    );
    await expect(setup.getByRole("textbox", { name: "Or run this on the server" })).toHaveValue(
        /authorized_keys$/,
    );

    const clusterId = new URL(page.url()).searchParams.get("clusterId") ?? "";

    expect(
        await sql("SELECT provisioning->>'caddyStorage' AS storage FROM clusters WHERE id = $1", [
            clusterId,
        ]),
    ).toEqual([{ storage: "true" }]);

    // The private keys never reach the browser.
    const headers = { origin: process.env.E2E_BASE_URL! };

    for (const [path, data] of [
        ["listClusters", {}],
        ["getProvisioning", { clusterId }],
    ] as const) {
        const response = await page.request.post(`/rpc/api/cluster/${path}`, { data, headers });
        const body = await response.text();

        expect(response.ok()).toBe(true);
        expect(body).not.toContain("PRIVATE KEY");
        expect(body).not.toContain("enc:v1:");
    }

    // Setup is followed on its deployment page.
    await setup.getByRole("button", { name: "Start setup" }).click();
    await expect(page).toHaveURL(/\/deployments\//u);
    const firstAttempt = page.url();
    const status = page.getByRole("status").first();

    await expect(status).toHaveText("Failed", { timeout: 45_000 });
    await expect(page.getByRole("region", { name: "Condensed deployment logs" })).not.toBeEmpty();

    // .invalid never connects, so nothing was created on the server and retrying needs no reset.
    await page.getByRole("button", { name: "Retry setup" }).click();
    await expect(page).not.toHaveURL(firstAttempt);
    await expect(status).toHaveText("Failed", { timeout: 45_000 });

    // A half-created cluster whose attempts were deleted still retries, after confirming the reset.
    await sql(
        `UPDATE clusters SET provisioning = jsonb_set(provisioning, '{initState}', '"partial"') WHERE id = $1`,
        [clusterId],
    );
    await sql("DELETE FROM deployments WHERE cluster_id = $1", [clusterId]);
    await page.goto("/clusters");
    await row(page, name).getByRole("button", { name, exact: true }).click();
    await setup.getByRole("button", { name: "Start setup" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reset and retry" }).click();
    await expect(page).toHaveURL(/\/deployments\//u);
    await expect(status).toHaveText("Failed", { timeout: 45_000 });

    await page.goto("/clusters");
    await expect(row(page, name)).toContainText("Failed");
    await askDelete(page, name);
    await dialog(page).getByRole("button", { name: "Delete" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, name)).toHaveCount(0);
    expect(await sql("SELECT id FROM clusters WHERE name = $1", [name])).toEqual([]);
});

test("an admin adds a machine in a dialog, follows it on its deployment page, retries, and discards it", async ({
    page,
}) => {
    test.setTimeout(3 * 60_000);
    const { id } = await createCluster(page);
    await page.goto(`/clusters/${id}`);
    await page.getByRole("button", { name: "Add machine" }).click();

    const add = page.getByRole("dialog", { name: "Add machine" });
    await expect(add.getByRole("button", { name: "Continue" })).toBeDisabled();
    // .invalid names never resolve, so adding fails without touching a real server.
    await add.getByLabel("Server address").fill("worker.invalid");
    await add.getByLabel("Machine name").fill("Worker-2");
    await add.getByRole("button", { name: "Continue" }).click();

    await expect(add.getByRole("textbox", { name: "Public key" })).toHaveValue(
        /^ssh-ed25519 \S+ stoat-/,
    );
    await expect(add.getByRole("textbox", { name: "Or run this on the server" })).toHaveValue(
        /authorized_keys$/,
    );
    expect(
        await sql("SELECT pending_machine->>'name' AS name FROM clusters WHERE id = $1", [id]),
    ).toEqual([{ name: "worker-2" }]);

    // The private key never reaches the browser.
    const pending = await page.request.post("/rpc/api/cluster/getPendingMachine", {
        data: { clusterId: id },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    const body = await pending.text();

    expect(pending.ok()).toBe(true);
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toContain("enc:v1:");

    // Adding is followed on its deployment page.
    await add.getByRole("button", { name: "Add machine" }).click();
    await expect(page).toHaveURL(/\/deployments\//u);
    await expect(page.getByRole("heading", { name: "New machine" })).toBeVisible();
    const firstAttempt = page.url();
    const status = page.getByRole("status").first();

    await expect(status).toHaveText("Failed", { timeout: 45_000 });
    await expect(page.getByText(/resolve worker\.invalid/u).first()).toBeVisible();

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page).not.toHaveURL(firstAttempt);
    await expect(status).toHaveText("Failed", { timeout: 45_000 });

    // The dialog picks the server up again, and discarding it deletes its key.
    await page.goto(`/clusters/${id}?dialog=add-machine`);
    await expect(add).toContainText("The last attempt failed.");
    await add.getByRole("button", { name: "Discard" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
    await expect(add.getByLabel("Server address")).toBeVisible();
    expect(
        await sql(
            "SELECT pending_machine IS NULL AND pending_machine_key IS NULL AS gone FROM clusters WHERE id = $1",
            [id],
        ),
    ).toEqual([{ gone: true }]);
});

test("an admin removes a machine, but not the one Stoat connects through", async ({ page }) => {
    await addWorker();
    const { id } = await createCluster(page);
    await page.goto(`/clusters/${id}`);

    await expect(row(page, MACHINE.name)).toContainText("Stoat connects through this machine");
    await expect(page.getByRole("button", { name: `Actions for ${MACHINE.name}` })).toHaveCount(0);

    await row(page, WORKER.name)
        .getByRole("button", { name: `Actions for ${WORKER.name}` })
        .click();
    await page.getByRole("menuitem", { name: "Remove machine" }).click();

    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`${WORKER.name} is down`);
    await confirm.getByRole("button", { name: "Remove machine" }).click();

    await expect(confirm).toBeHidden();
    await expect(page.getByText(`Removed ${WORKER.name}`)).toBeVisible();
    await expect(row(page, WORKER.name)).toHaveCount(0);
    await expect(page).not.toHaveURL(/machine=/u);
});

test("an admin replaces the cluster's domain with their own, then removes it", async ({ page }) => {
    const { id } = await createCluster(page);
    await page.goto(`/clusters/${id}`);
    await expect(domainCard(page)).toContainText(SIDECAR_DOMAIN);
    await expect(domainCard(page)).toContainText("Uncloud DNS");

    await domainCard(page).getByRole("button", { name: "Change" }).click();
    const edit = page.getByRole("dialog", { name: "Cluster domain" });
    await edit.getByLabel("Domain").fill("Apps.Example.com");
    await edit.getByRole("button", { name: "Save domain" }).click();

    // Giving up the reserved domain is permanent, so it needs its own confirmation.
    const release = page.getByRole("alertdialog");
    await expect(release).toContainText(`Release ${SIDECAR_DOMAIN}?`);
    await release.getByRole("button", { name: "Release and save" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(domainCard(page)).toContainText("Your DNS");
    await expect(domainCard(page)).toContainText("*.apps.example.com");

    await domainCard(page).getByRole("button", { name: "Remove domain" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove domain" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(domainCard(page)).toContainText("Not set");
    await resetSidecar();
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
    await askDelete(page, cluster.name);
    await expect(dialog(page)).toContainText("Its 1 project will also be removed.");
    await dialog(page).getByRole("button", { name: "Delete" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(row(page, cluster.name)).toHaveCount(0);
    expect(await sql("SELECT id FROM projects WHERE cluster_id = $1", [cluster.id])).toEqual([]);
});

test("a cluster whose projects hold buckets is kept", async ({ page }) => {
    await page.goto("/clusters");
    await askDelete(page, "Main");
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
    const health = await page.request.post("/rpc/api/cluster/healthz", {
        data: { clusterId: cluster.id },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    expect(health.ok()).toBe(true);
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
            page.getByRole("link", { name: `${cluster.name}-internal`, exact: true }),
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
