import { expect, test, type Page } from "@playwright/test";
import { memberStorageState, openCreatedResource, rpc, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog");

const editor = (page: Page) => page.locator(".cm-content");

const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "breadcrumb" });

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

        // Creating a project opens it, on the canvas by default.
        await page.getByRole("link", { name: "List view" }).click();
        await expect(breadcrumb(page)).toContainText(name);
        await expect(page.getByRole("main").getByText("No resources yet")).toBeVisible();
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
        await page.goto(`/projects/${id}`);

        await page.getByRole("button", { name: "Edit project" }).click();
        await dialog(page).getByLabel("Name").fill(renamed);
        await dialog(page).getByRole("button", { name: /save/iu }).click();
        await expect(dialog(page)).toHaveCount(0);

        await expect(breadcrumb(page)).toContainText(renamed);
        expect(await sql("SELECT name FROM projects WHERE id = $1", [id])).toEqual([
            { name: renamed },
        ]);
    });
});

test.describe("resources", () => {
    test("a Compose resource is created, then its draft autosaves", async ({ page }) => {
        const { id: projectId } = await project(page);
        const name = unique("api");
        await page.goto(`/projects/${projectId}`);

        await page.getByRole("link", { name: "Create resource" }).first().click();
        await page
            .getByRole("link", { name: /^Compose\b/u })
            .first()
            .click();
        await page.getByLabel("Name").fill(name);
        await page.getByRole("button", { name: "Create resource" }).click();
        const resourceId = await openCreatedResource(page, projectId);

        await expect(breadcrumb(page)).toContainText(name);

        await replaceCompose(page, nginx);
        await expect(page.getByText("Unsaved changes")).toBeVisible();
        await expect(page.getByText("Saved — not deployed")).toBeVisible();
        expect(await draftSpec(resourceId)).toBe(nginx);

        // The draft survives a reload and marks the deploy as pending.
        await page.reload();
        await expect(editor(page)).toContainText("image: nginx:alpine");
        await expect(
            page.getByRole("button", { name: /Deploy.*undeployed changes/u }),
        ).toBeVisible();
    });

    test("an edit made just before leaving the page is kept", async ({ page }) => {
        const { id: projectId } = await project(page);

        const { id: resourceId } = await rpc(page, "resources/createResource", {
            projectId,
            name: unique("quick"),
            type: "compose",
        });

        await page.goto(`/projects/${projectId}/${resourceId}`);
        await expect(editor(page)).toBeVisible();

        await replaceCompose(page, nginx);
        // Straight away, before the autosave delay.
        await page.getByRole("link", { name: "Variables" }).first().click();
        await expect(page).toHaveURL(/\/variables$/u);

        await expect.poll(() => draftSpec(resourceId)).toBe(nginx);
    });

    test("invalid Compose is saved but cannot be deployed", async ({ page }) => {
        const { id: projectId } = await project(page);

        const { id: resourceId } = await rpc(page, "resources/createResource", {
            projectId,
            name: unique("broken"),
            type: "compose",
        });

        await page.goto(`/projects/${projectId}/${resourceId}`);

        await replaceCompose(page, "services: [not, a, map\n");
        await expect(
            page.getByRole("alert").filter({ hasText: "Saved draft cannot be deployed" }),
        ).toBeVisible();
        // Nothing was ever deployed, so there is nothing to fail to look up.
        await expect(page.getByText("No containers found.")).toBeVisible();
        await expect(page.getByRole("button", { name: /^Deploy/u })).toBeDisabled();
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

        await expect(breadcrumb(page)).toContainText(name);
        await expect(editor(page)).toContainText("ntfy");
        await expect(page.getByRole("button", { name: /^Deploy/u })).toBeEnabled();
    });

    test("a database template offers its connection details", async ({ page }) => {
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

        await expect(breadcrumb(page)).toContainText(name);
        await expect(page.getByRole("region", { name: /connection/iu })).toBeVisible();
        expect(
            await sql("SELECT settings->>'engine' AS engine FROM resources WHERE name = $1", [
                name,
            ]),
        ).toEqual([{ engine: "postgresql" }]);
    });

    test("a resource's name and description are edited in its settings", async ({ page }) => {
        const { id: projectId } = await project(page);

        const { id: resourceId } = await rpc(page, "resources/createResource", {
            projectId,
            name: unique("old"),
            type: "compose",
        });

        const renamed = unique("new");
        await page.goto(`/projects/${projectId}/${resourceId}/settings`);

        await page.getByRole("textbox", { name: /^Name$/u }).fill(renamed);
        await page
            .getByRole("textbox", { name: "Description", exact: true })
            .fill("Handles payments");
        await page.getByRole("button", { name: /save/iu }).first().click();

        await expect(breadcrumb(page)).toContainText(renamed);
        expect(
            await sql("SELECT name, description FROM resources WHERE id = $1", [resourceId]),
        ).toEqual([{ name: renamed, description: "Handles payments" }]);
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
        // Projects open on the canvas by default; its cards are not links.
        await page.getByRole("link", { name: "List view" }).click();
        const api = page.getByRole("main").getByRole("link", { name: "api", exact: true });
        await expect(api).toBeVisible();
        await api.click();
        await expect(editor(page)).toContainText("nginx:alpine");
    });
});
