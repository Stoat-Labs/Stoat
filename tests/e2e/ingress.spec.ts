import { expect, test, type Page } from "@playwright/test";
import { receivedComposes, resetSidecar, rpc, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog");

let created = 0;

/** A resource with one `web` service on a cluster of its own. */
async function resource(page: Page) {
    created += 1;
    const suffix = `${Date.now()}-${created}`;
    await page.goto("/projects");

    const cluster = await rpc(page, "cluster/createCluster", {
        name: `Ingress cluster ${suffix}`,
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    const project = await rpc(page, "projects/createProject", {
        name: `Ingress project ${suffix}`,
        clusterId: cluster.id,
    });

    const { id } = await rpc(page, "resources/createResource", {
        projectId: project.id,
        name: `site-${created}`,
        type: "compose",
    });

    await sql("UPDATE resources SET draft_spec = $2 WHERE id = $1", [
        id,
        "services:\n  web:\n    image: nginx:alpine\n",
    ]);

    return { id, path: `/projects/${project.id}/${id}` };
}

async function draftSpec(resourceId: string) {
    const [row] = await sql<{ draft_spec: string }>(
        "SELECT draft_spec FROM resources WHERE id = $1",
        [resourceId],
    );

    return row?.draft_spec ?? "";
}

test.beforeEach(async () => {
    await resetSidecar();
});

test("an HTTP route is added in a dialog, deployed, and removed again", async ({ page }) => {
    const target = await resource(page);
    await page.goto(`${target.path}/ingress`);

    await page.getByRole("button", { name: "Create ingress" }).click();
    await dialog(page).getByLabel("Hostname").fill("shop.example.test");
    await dialog(page).getByLabel("Container port").fill("8080");
    await dialog(page).getByRole("button", { name: "Add to Compose" }).click();
    await expect(dialog(page)).toHaveCount(0);

    const route = "shop.example.test:8080/https";
    await expect(page.getByText(route).first()).toBeVisible();
    await expect.poll(() => draftSpec(target.id)).toContain(route);

    // Deploying sends the route to the cluster.
    await page.goto(target.path);
    await page.getByRole("button", { name: /^Deploy/u }).click();
    await expect(page.getByRole("status").first()).toHaveText("Ready");
    expect((await receivedComposes())[0]).toContain(route);

    await page.goto(`${target.path}/ingress`);
    await page.getByRole("button", { name: `Remove ${route}` }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Remove "${route}" from service "web"?`);
    await confirm.getByRole("button", { name: "Remove" }).click();

    await expect(page.getByText(route)).toHaveCount(0);
    await expect.poll(() => draftSpec(target.id)).not.toContain(route);
});

test("cancelling a removal keeps the route", async ({ page }) => {
    const target = await resource(page);
    await sql("UPDATE resources SET draft_spec = $2 WHERE id = $1", [
        target.id,
        'services:\n  web:\n    image: nginx:alpine\n    x-ports:\n      - "kept.example.test:80/https"\n',
    ]);
    await page.goto(`${target.path}/ingress`);

    await page.getByRole("button", { name: "Remove kept.example.test:80/https" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByText("kept.example.test:80/https").first()).toBeVisible();
    expect(await draftSpec(target.id)).toContain("kept.example.test:80/https");
});
