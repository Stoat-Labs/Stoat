import { expect, test, type Page } from "@playwright/test";
import { memberStorageState, openCreatedResource, resourcePath, rpc, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog");

const editor = (page: Page) => page.locator(".cm-content");

// The canvas header names the open project.
const projectSwitcher = (page: Page) => page.getByRole("button", { name: "Switch project" });

// The resource panel's heading.
const panelTitle = (page: Page) => page.getByRole("heading", { level: 2 });

let created = 0;

function unique(prefix: string) {
    created += 1;

    return `${prefix} ${Date.now()}-${created}`;
}

/** A cluster and project of this test's own, so lists and counts stay predictable. */
async function project(page: Page) {
    await page.goto("/projects");

    const cluster = await rpc(page, "cluster/createCluster", {
        name: unique("Projects cluster"),
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    const name = unique("Project");
    const { id } = await rpc(page, "projects/createProject", { name, clusterId: cluster.id });

    return { id, name, clusterId: cluster.id };
}

async function draftSpec(resourceId: string) {
    const [row] = await sql<{ draft_spec: string | null }>(
        "SELECT draft_spec FROM resources WHERE id = $1",
        [resourceId],
    );

    return row?.draft_spec;
}

/** Replaces the whole Compose draft in the editor. */
async function replaceCompose(page: Page, text: string) {
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    // CodeMirror auto-indents typed newlines, so paste-like insertion keeps the YAML exact.
    await page.keyboard.insertText(text);
}

const nginx = "services:\n  web:\n    image: nginx:alpine\n";

test.describe("projects", () => {
    test("a project is created in a dialog on a chosen cluster", async ({ page }) => {
        await page.goto("/clusters");
        const clusterName = unique("Home");
        await rpc(page, "cluster/createCluster", {
            name: clusterName,
            sidecarUrl: process.env.E2E_SIDECAR_URL!,
            sidecarToken: "e2e-token",
        });
        const name = unique("Website");

        await page.goto("/projects");
        await page
            .getByRole("button", { name: /new project|create project/iu })
            .first()
            .click();
        await dialog(page).getByLabel("Name").fill(name);
        await dialog(page).getByLabel("Description").fill("Marketing site");
        await dialog(page).getByRole("combobox", { name: "Select a cluster" }).click();
        await page.getByRole("option", { name: clusterName }).click();
        await dialog(page).getByRole("button", { name: "Create Project" }).click();
        await expect(dialog(page)).toHaveCount(0);

        // Creating a project opens its canvas.
        await expect(page).toHaveURL(/\/projects\/[\w-]+\/canvas/u);
        await expect(projectSwitcher(page)).toContainText(name);
        expect(
            await sql(
                `SELECT p.description, c.name AS cluster FROM projects p
                 JOIN clusters c ON c.id = p.cluster_id WHERE p.name = $1`,
                [name],
            ),
        ).toEqual([{ description: "Marketing site", cluster: clusterName }]);
    });

    test("a project can be renamed", async ({ page }) => {
        const { id } = await project(page);
        const renamed = unique("Renamed");
        await page.goto(`/projects/${id}/canvas`, { waitUntil: "networkidle" });

        await page.getByRole("button", { name: "Project settings" }).click();
        await dialog(page).getByLabel("Name").fill(renamed);
        await dialog(page).getByRole("button", { name: /save/iu }).click();
        await expect(dialog(page)).toHaveCount(0);

        await expect(projectSwitcher(page)).toContainText(renamed);
        expect(await sql("SELECT name FROM projects WHERE id = $1", [id])).toEqual([
            { name: renamed },
        ]);
    });
});

test.describe("resources", () => {
    test("a Compose resource is created, then its draft is saved", async ({ page }) => {
        const { id: projectId } = await project(page);
        const name = unique("api");
        await page.goto(`/projects/${projectId}/create`);

        await page
            .getByRole("link", { name: /^Compose\b/u })
            .first()
            .click();
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create resource" }).click();
        const resourceId = await openCreatedResource(page, projectId);

        await expect(panelTitle(page)).toContainText(name);

        await page.getByRole("tab", { name: "Compose" }).click();
        await replaceCompose(page, nginx);
        await page.getByRole("button", { name: "Save draft" }).click();
        await expect.poll(() => draftSpec(resourceId)).toBe(nginx);

        // The draft survives a reload and is staged for the next deploy.
        await page.reload();
        await expect(editor(page)).toContainText("image: nginx:alpine");
        await expect(page.getByText("1 change", { exact: true })).toBeVisible();
    });

    test("invalid Compose is saved but cannot be deployed", async ({ page }) => {
        const { id: projectId } = await project(page);

        const { id: resourceId } = await rpc(page, "resources/createResource", {
            projectId,
            name: unique("broken"),
            type: "compose",
        });

        await page.goto(resourcePath(projectId, resourceId, "compose"));

        await replaceCompose(page, "services: [not, a, map\n");
        await page.getByRole("button", { name: "Save draft" }).click();
        await expect.poll(() => draftSpec(resourceId)).toBe("services: [not, a, map\n");

        await page.getByRole("button", { name: "Deploy", exact: true }).click();
        await expect(page.getByText(/Save a valid Compose spec/u)).toBeVisible();
        expect(
            await sql("SELECT id FROM deployments WHERE resource_id = $1", [resourceId]),
        ).toEqual([]);
    });

    test("a template creates a ready-to-deploy resource", async ({ page }) => {
        const { id: projectId } = await project(page);
        const name = unique("notify");
        await page.goto(`/projects/${projectId}/create`);

        await page.getByLabel("Search templates").fill("ntfy");
        await page.getByRole("link", { name: /ntfy/iu }).first().click();
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create resource" }).click();
        await openCreatedResource(page, projectId);

        await expect(panelTitle(page)).toContainText(name);
        await page.getByRole("tab", { name: "Compose" }).click();
        await expect(editor(page)).toContainText("ntfy");
        await expect(page.getByRole("button", { name: "Deploy", exact: true })).toBeEnabled();
    });

    test("a database template opens with its database tabs", async ({ page }) => {
        const { id: projectId } = await project(page);
        const name = unique("db");
        await page.goto(`/projects/${projectId}/create`);

        await page
            .getByRole("link", { name: /PostgreSQL/u })
            .first()
            .click();
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create resource" }).click();
        await openCreatedResource(page, projectId);

        await expect(panelTitle(page)).toContainText(name);
        await expect(page.getByRole("tab", { name: "Tables" })).toBeVisible();
        expect(
            await sql("SELECT settings->>'engine' AS engine FROM resources WHERE name = $1", [
                name,
            ]),
        ).toEqual([{ engine: "postgresql" }]);
    });

    test("Back and Forward walk through the canvas panels that were opened", async ({ page }) => {
        const { id: projectId } = await project(page);

        const create = async (name: string) => {
            const { id } = await rpc(page, "resources/createResource", {
                projectId,
                name,
                type: "compose",
            });

            return { id, name };
        };

        const first = await create(unique("first"));
        const second = await create(unique("second"));

        const panel = (name: string) =>
            page.getByRole("complementary", { name: `${name} details` });

        // The canvas keeps a deployment stream open, so wait for its panel rather than network idle.
        await page.goto(`/projects/${projectId}/canvas?node=${first.id}`);
        await expect(panel(first.name)).toBeVisible();

        await panel(first.name).getByRole("tab", { name: "Settings" }).click();
        await expect(page).toHaveURL(/tab=settings/u);

        // The open panel covers the other card, so close it first.
        await panel(first.name).getByRole("button", { name: "Close details" }).click();
        // URL writes are throttled; selecting before the close lands would merge both into one entry.
        await expect(page).not.toHaveURL(/node=/u);
        await page.locator(`.svelte-flow__node[data-id="${second.id}"]`).click();
        await expect(panel(second.name)).toBeVisible();
        // The panel shows the queued value before the throttled write lands, and Back drops queued writes.
        await expect(page).toHaveURL(new RegExp(`node=${second.id}`, "u"));

        await page.goBack();
        await expect(panel(second.name)).toBeHidden();

        await page.goBack();
        await expect(panel(first.name)).toBeVisible();
        await expect(panel(first.name).getByRole("tab", { name: "Settings" })).toHaveAttribute(
            "aria-selected",
            "true",
        );

        await page.goBack();
        await expect(page).not.toHaveURL(/tab=/u);
        await expect(panel(first.name).getByRole("tab", { name: "Settings" })).toHaveAttribute(
            "aria-selected",
            "false",
        );

        await page.goForward();
        await page.goForward();
        await page.goForward();
        await expect(panel(second.name)).toBeVisible();
    });
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("projects and resources can be browsed", async ({ page }) => {
        await page.goto("/projects");
        await page.getByRole("link", { name: "Shop" }).first().click();
        // Projects open on the canvas; a card opens its resource's panel.
        await page.locator(".svelte-flow__node").getByText("api", { exact: true }).click();
        await expect(panelTitle(page)).toContainText("api");
        await page.getByRole("tab", { name: "Compose" }).click();
        await expect(editor(page)).toContainText("nginx:alpine");
    });
});
