import { expect, test, type Page } from "@playwright/test";
import { FAILING_IMAGE, HANGING_IMAGE, LOG_LINES } from "./fake-sidecar";
import {
    receivedComposes,
    resourcePath,
    resetSidecar,
    rpc,
    runningServices,
    rustfsRoot,
    sql,
} from "./fixtures";

// The canvas bar's Deploy, not the Deploy section of a resource's settings.
const deployButton = (page: Page) =>
    page.locator("header").getByRole("button", { name: "Deploy", exact: true });

/** The deployment page's own status badge, not the per-step ones in the log. */
const status = (page: Page) => page.getByRole("status").first();

let created = 0;

/** A resource on a cluster of its own, with `image` as its one service's image. */
async function resource(page: Page, image = "nginx:alpine") {
    created += 1;
    const suffix = `${Date.now()}-${created}`;
    await page.goto("/projects");

    const cluster = await rpc(page, "cluster/createCluster", {
        name: `Deploy cluster ${suffix}`,
        sidecarUrl: process.env.E2E_SIDECAR_URL!,
        sidecarToken: "e2e-token",
    });

    const project = await rpc(page, "projects/createProject", {
        name: `Deploy project ${suffix}`,
        clusterId: cluster.id,
    });

    const name = `web-${created}`;

    const { id } = await rpc(page, "resources/createResource", {
        projectId: project.id,
        name,
        type: "compose",
    });

    await sql("UPDATE resources SET draft_spec = $2 WHERE id = $1", [
        id,
        `services:\n  web:\n    image: ${image}\n`,
    ]);

    const [row] = await sql<{ slug: string }>("SELECT slug FROM resources WHERE id = $1", [id]);

    return {
        id,
        slug: row!.slug,
        name,
        projectName: `Deploy project ${suffix}`,
        projectId: project.id,
        path: resourcePath(project.id, id),
    };
}

/** Deploys from the canvas bar, then follows the deployment on its own page. */
async function deploy(page: Page, path: string) {
    await page.goto(path);
    const before = await sql("SELECT id FROM deployments");
    await expect(deployButton(page)).toBeEnabled();
    await deployButton(page).click();

    let id = "";

    await expect
        .poll(async () => {
            const rows = await sql<{ id: string }>("SELECT id FROM deployments");

            id = rows.find((row) => !before.some((old) => old.id === row.id))?.id ?? "";

            return id;
        })
        .not.toBe("");
    await page.goto(`/deployments/${id}`);
}

test.beforeEach(async () => {
    await resetSidecar();
});

test("a deploy streams to ready, then the resource shows its running container", async ({
    page,
}) => {
    const target = await resource(page);
    await page.goto(target.path);
    await expect(page.getByText("1 change", { exact: true })).toBeVisible();
    await deploy(page, target.path);

    await expect(
        page.getByRole("heading", { name: `${target.projectName} / ${target.name}` }),
    ).toBeVisible();
    await expect(status(page)).toHaveText("Ready");
    await expect(page.getByText(/Started .*web/u).first()).toBeVisible();

    const [compose] = await receivedComposes();
    expect(compose).toContain("image: nginx:alpine");

    // Nothing is staged any more, and the panel's history shows the deploy and its container.
    await page.goto(target.path);
    await expect(page.getByText("1 Container")).toBeVisible();
    await expect(page.getByText("Deployment successful")).toBeVisible();
    await expect(deployButton(page)).toHaveCount(0);

    // It is in the organization-wide list.

    await page.goto("/deployments");
    await expect(page.getByRole("row").filter({ hasText: target.name }).first()).toContainText(
        "Ready",
    );
});

test("a failing deploy shows the cluster's error and stays failed", async ({ page }) => {
    const target = await resource(page, FAILING_IMAGE);
    await deploy(page, target.path);

    await expect(page.getByText(`Unable to pull image ${FAILING_IMAGE}`).first()).toBeVisible();
    await expect(status(page)).toHaveText("Failed");
    await expect(page.getByRole("button", { name: "Cancel deployment" })).toHaveCount(0);
});

test("cancelling a stuck deploy stops it and allows the next one", async ({ page }) => {
    const target = await resource(page, HANGING_IMAGE);
    await deploy(page, target.path);

    await expect(status(page)).toHaveText("Running");
    await page.getByRole("button", { name: "Cancel deployment" }).click();
    await expect(status(page)).toHaveText("Cancelled");

    const [row] = await sql<{ status: string }>(
        "SELECT status FROM deployments WHERE resource_id = $1",
        [target.id],
    );

    expect(row?.status).toBe("cancelled");

    // Nothing is left holding the resource: a fixed draft deploys.
    await sql("UPDATE resources SET draft_spec = $2 WHERE id = $1", [
        target.id,
        "services:\n  web:\n    image: nginx:alpine\n",
    ]);
    await deploy(page, target.path);
    await expect(status(page)).toHaveText("Ready");
});

test("only one deploy of a resource runs at a time", async ({ page }) => {
    const target = await resource(page, HANGING_IMAGE);
    await deploy(page, target.path);
    await expect(status(page)).toHaveText("Running");

    const second = await page.request.post("/rpc/api/resources/deploy", {
        data: { projectId: target.projectId, resourceId: target.id },
        headers: { origin: process.env.E2E_BASE_URL! },
    });

    expect(second.ok()).toBe(false);

    await page.getByRole("button", { name: "Cancel deployment" }).click();
    await expect(status(page)).toHaveText("Cancelled");
});

test("live logs stream from the running service", async ({ page }) => {
    const target = await resource(page);
    await deploy(page, target.path);
    await expect(status(page)).toHaveText("Ready");

    await page.goto(resourcePath(target.projectId, target.id, "logs"));

    for (const line of LOG_LINES) await expect(page.getByText(line).first()).toBeVisible();
});

test.describe("deleting", () => {
    const confirmDialog = (page: Page) => page.getByRole("alertdialog");

    /** Whether the fake cluster still runs a service of this resource. */
    async function runsServiceOf(slug: string) {
        return (await runningServices()).some((name) => name.startsWith(`${slug}-`));
    }

    // Delete stages the deletion on the canvas; deploying the staged changes applies it.
    async function deleteResource(page: Page, target: { projectId: string; id: string }) {
        await page.goto(resourcePath(target.projectId, target.id, "settings"));
        await page.getByRole("button", { name: "Delete resource" }).click();
        await expect(page.getByText("Will be deleted")).toBeVisible();
        await deployButton(page).click();
        await expect(confirmDialog(page)).toContainText("Volumes stay on the machines.");
        await confirmDialog(page).getByRole("button", { name: "Deploy" }).click();
    }

    test("a deployed resource's services stop and the resource is gone", async ({ page }) => {
        const target = await resource(page);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Ready");
        expect(await runsServiceOf(target.slug)).toBe(true);

        await deleteResource(page, target);

        await expect
            .poll(() => sql("SELECT id FROM resources WHERE id = $1", [target.id]))
            .toEqual([]);
        expect(await runsServiceOf(target.slug)).toBe(false);
        expect(await sql("SELECT id FROM deployments WHERE resource_id = $1", [target.id])).toEqual(
            [],
        );
    });

    test("a never-deployed resource is simply removed", async ({ page }) => {
        const target = await resource(page);
        await deleteResource(page, target);

        await expect
            .poll(() => sql("SELECT id FROM resources WHERE id = $1", [target.id]))
            .toEqual([]);
    });

    test("a resource that is still deploying is kept", async ({ page }) => {
        const target = await resource(page, HANGING_IMAGE);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Running");
        const deployment = page.url();

        await deleteResource(page, target);
        await expect(confirmDialog(page)).toContainText("is deploying");
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toHaveLength(1);

        await page.goto(deployment);
        await page.getByRole("button", { name: "Cancel deployment" }).click();
        await expect(status(page)).toHaveText("Cancelled");
    });

    test("a resource whose cluster cannot be reached is kept", async ({ page }) => {
        const target = await resource(page);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Ready");
        await sql(
            `UPDATE clusters SET sidecar_url = 'http://127.0.0.1:9'
             WHERE id = (SELECT cluster_id FROM projects WHERE id = $1)`,
            [target.projectId],
        );

        await deleteResource(page, target);

        // Deleting the row anyway would leave its services running with no way to stop them.
        await expect(confirmDialog(page)).toContainText("Could not remove service");
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toHaveLength(1);
    });

    test("a resource another one references is kept", async ({ page }) => {
        const target = await resource(page);

        const { id: user } = await rpc(page, "resources/createResource", {
            projectId: target.projectId,
            name: `user-${created}`,
            type: "compose",
        });

        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [user, `URL={{ ${target.id}.STOAT_PREFIX }}\n`],
        );

        await deleteResource(page, target);

        await expect(confirmDialog(page)).toContainText(`"user-${created}" still references`);
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toHaveLength(1);
    });

    test("deleting a project removes its resources and their services", async ({ page }) => {
        const target = await resource(page);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Ready");

        await page.goto(`/projects/${target.projectId}/canvas`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Project settings" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
        await expect(confirmDialog(page)).toContainText("This cannot be undone.");
        await confirmDialog(page).getByRole("button", { name: "Delete project" }).click();

        await expect(page).toHaveURL(/\/projects$/u);
        expect(await runsServiceOf(target.slug)).toBe(false);
        expect(await sql("SELECT id FROM projects WHERE id = $1", [target.projectId])).toEqual([]);
    });

    test("a project with an S3 bucket is kept until the bucket is deleted", async ({ page }) => {
        const target = await resource(page);

        const connection = await rpc(page, "s3/create", {
            name: `Deletion storage ${created}`,
            connection: {
                provider: "rustfs",
                endpoint: process.env.E2E_RUSTFS_ENDPOINT!,
                ...rustfsRoot,
            },
        });

        await rpc(page, "buckets/create", {
            projectId: target.projectId,
            connectionId: connection.id,
            name: "keep",
            bucket: `keep-${Date.now()}`,
        });

        const refused = await page.request.post("/rpc/api/projects/deleteProject", {
            data: { projectId: target.projectId },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(refused.status()).toBe(409);
        expect(await refused.text()).toContain('Delete the S3 bucket \\"keep\\"');
        expect(await sql("SELECT id FROM projects WHERE id = $1", [target.projectId])).toHaveLength(
            1,
        );
    });
});
