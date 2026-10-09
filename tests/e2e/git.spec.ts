import { expect, test, type Page } from "@playwright/test";
import { commitOnServer, committedFile, gitServer, initialCompose } from "./git-server";
import { clientHeaders, memberStorageState, rpc, sql, storageState } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog");

const confirmDialog = (page: Page) => page.getByRole("alertdialog");

const editor = (page: Page) => page.locator(".cm-content");

const panel = (page: Page) => page.getByRole("region", { name: "Git source" });

let created = 0;

function unique(prefix: string) {
    created += 1;

    return `${prefix} ${Date.now()}-${created}`;
}

/** A generic SSH connection to the test Git server, created through the API. */
async function connection(page: Page) {
    const server = gitServer();
    const name = unique("Git server");

    const { id } = await rpc(page, "connections/create", {
        name,
        provider: "generic",
        serverUrl: server.serverUrl,
        credentials: {
            username: "git",
            privateKey: server.privateKey,
            knownHosts: server.knownHosts,
        },
        repositories: [{ url: server.repositoryUrl, name: "app", defaultBranch: "main" }],
    });

    return { id, name };
}

/** A resource bound to the repository's `compose.yaml`, in a project of its own. */
async function gitResource(page: Page) {
    await page.goto("/git");
    const { id: connectionId } = await connection(page);

    const cluster = await rpc(page, "cluster/createCluster", {
        name: unique("Git cluster"),
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    const project = await rpc(page, "projects/createProject", {
        name: unique("Git project"),
        clusterId: cluster.id,
    });

    const { id } = await rpc(page, "resources/createResource", {
        projectId: project.id,
        name: `from-git-${created}`,
        type: "compose",
        git: {
            connectionId,
            repositoryUrl: gitServer().repositoryUrl,
            branch: "main",
            path: "compose.yaml",
        },
    });

    return { id, path: `/projects/${project.id}/${id}` };
}

/** Replaces the whole Compose draft in the editor. */
async function replaceCompose(page: Page, text: string) {
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(text);
}

// Each test leaves the repository's compose.yaml as it found it.
test.afterEach(() => {
    if (committedFile("compose.yaml") !== initialCompose)
        commitOnServer("compose.yaml", initialCompose, "Reset compose");
});

test("an SSH Git server is connected in a dialog", async ({ page }) => {
    const server = gitServer();
    const name = unique("Self-hosted");
    await page.goto("/git");
    await page.getByRole("button", { name: "Add connection" }).click();

    const add = dialog(page);
    await add.getByLabel("Connection name").fill(name);
    await add.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "Generic Git server" }).click();
    await add.getByLabel("Git server URL").fill(server.serverUrl);
    await add.getByRole("combobox", { name: "Credential type" }).click();
    await page.getByRole("option", { name: "SSH private key / known hosts" }).click();
    await add.getByLabel("Username (optional)").fill("git");
    await add.getByLabel("SSH private key").fill(server.privateKey);
    await add.getByLabel("Known hosts").fill(server.knownHosts);
    await add.getByLabel("Known repositories").fill(server.repositoryUrl);

    await add.getByRole("button", { name: "Test connection" }).click();
    await expect(
        add.getByRole("status").filter({ hasText: "1 accessible repository" }),
    ).toBeVisible();
    await add.getByRole("button", { name: "Add connection" }).click();
    await expect(add).toHaveCount(0);

    await page
        .getByRole("link", { name: new RegExp(name, "u") })
        .first()
        .click();
    await expect(page.getByRole("cell", { name: server.repositoryUrl })).toBeVisible();
});

test("a wrong host key is refused before anything is stored", async ({ page }) => {
    const server = gitServer();
    await page.goto("/git");

    const response = await page.request.post("/rpc/connections/create", {
        data: {
            json: {
                name: unique("Spoofed"),
                provider: "generic",
                serverUrl: server.serverUrl,
                credentials: {
                    username: "git",
                    privateKey: server.privateKey,
                    // Some other server's key.
                    knownHosts: `${server.address} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFSBlmPpGBkQXr1QG8V4QbVnWDQ3z1G6ZpYw7J5r6s0Q\n`,
                },
                repositories: [{ url: server.repositoryUrl, name: "app", defaultBranch: "main" }],
            },
        },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    expect(response.ok()).toBe(false);
});

test("a resource is created from a repository's Compose file", async ({ page }) => {
    const { name: connectionName } = await connection(page);

    const cluster = await rpc(page, "cluster/createCluster", {
        name: unique("Git cluster"),
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    const project = await rpc(page, "projects/createProject", {
        name: unique("Git project"),
        clusterId: cluster.id,
    });

    const name = `imported-${created}`;
    await page.goto(`/projects/${project.id}/create`);
    await page.getByRole("link", { name: /Compose from Git/u }).click();

    await page.getByLabel("Name", { exact: false }).first().fill(name);
    await page.getByRole("combobox", { name: /Git connection/u }).click();
    await page.getByRole("option", { name: connectionName }).click();
    await page.getByRole("combobox", { name: /Repository/u }).click();
    await page.getByRole("option", { name: /app/u }).click();
    await page.getByLabel("Branch").fill("main");
    await page.getByLabel("Compose file or directory").fill("compose.yaml");
    await page.getByRole("button", { name: "Create resource" }).click();

    await expect(page.getByRole("navigation", { name: "breadcrumb" })).toContainText(name);
    await expect(editor(page)).toContainText("image: nginx:alpine");
    await page.goto(`${new URL(page.url()).pathname}/settings`);
    await expect(panel(page)).toContainText("/ main / compose.yaml");
});

test("pulling replaces the draft with what was pushed elsewhere", async ({ page }) => {
    const target = await gitResource(page);
    commitOnServer("compose.yaml", "services:\n  web:\n    image: caddy:2\n", "Switch to Caddy");
    await page.goto(`${target.path}/settings`);

    await panel(page).getByRole("button", { name: "Pull from Git" }).click();
    await expect(confirmDialog(page)).toContainText("Replace the Compose draft?");
    await confirmDialog(page).getByRole("button", { name: "Replace" }).click();

    await expect(page.getByText("Compose imported from Git.")).toBeVisible();
    await page.goto(target.path);
    await expect(editor(page)).toContainText("image: caddy:2");
});

test("a pull can be called off", async ({ page }) => {
    const target = await gitResource(page);
    commitOnServer("compose.yaml", "services:\n  web:\n    image: caddy:2\n", "Switch to Caddy");
    await page.goto(`${target.path}/settings`);

    await panel(page).getByRole("button", { name: "Pull from Git" }).click();
    await confirmDialog(page).getByRole("button", { name: "Cancel" }).click();

    await expect(confirmDialog(page)).toHaveCount(0);
    await page.goto(target.path);
    await expect(editor(page)).toContainText("image: nginx:alpine");
});

test("commit and push sends the draft to the repository", async ({ page }) => {
    const target = await gitResource(page);
    const edited = "services:\n  web:\n    image: nginx:1.29\n";
    await page.goto(target.path);

    await replaceCompose(page, edited);
    await expect(page.getByText("Draft saved.")).toBeVisible();
    await page.goto(`${target.path}/settings`);
    await panel(page).getByLabel("Commit message").fill("Pin nginx");
    await panel(page).getByRole("button", { name: "Commit & push" }).click();

    await expect(page.getByText("Commit pushed and draft saved.")).toBeVisible();
    expect(committedFile("compose.yaml")).toBe(edited);
});

test("detaching keeps the draft but forgets the repository", async ({ page }) => {
    const target = await gitResource(page);
    await page.goto(`${target.path}/settings`);

    await panel(page).getByRole("button", { name: "Detach" }).click();
    await confirmDialog(page).getByRole("button", { name: "Detach" }).click();

    await expect(page.getByRole("tab", { name: "Raw", selected: true })).toBeVisible();
    await page.goto(target.path);
    await expect(editor(page)).toContainText("image: nginx:alpine");
    expect(await sql("SELECT git_connection_id FROM resources WHERE id = $1", [target.id])).toEqual(
        [{ git_connection_id: null }],
    );
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("connections are read-only and pushing is left to admins", async ({ page, browser }) => {
        // The owner sets up a Git-backed resource for the member to look at.
        const owner = await browser.newPage({
            baseURL: process.env.E2E_BASE_URL,
            storageState,
            extraHTTPHeaders: clientHeaders(),
        });

        const target = await gitResource(owner);
        await owner.close();

        await page.goto("/git");
        await expect(page.getByRole("button", { name: "Add connection" })).toHaveCount(0);

        await page.goto(`${target.path}/settings`);
        await expect(panel(page)).toContainText("Only administrators can push to Git.");
        await expect(panel(page).getByRole("button", { name: "Commit & push" })).toHaveCount(0);
    });
});
