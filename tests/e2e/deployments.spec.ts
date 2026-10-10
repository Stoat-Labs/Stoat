import { expect, test, type Page } from "@playwright/test";
import { FAILING_IMAGE, HANGING_IMAGE, LOG_LINES } from "./fake-sidecar";
import {
    memberStorageState,
    receivedComposes,
    resetSidecar,
    rpc,
    runningServices,
    rustfsRoot,
    sql,
} from "./fixtures";

const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "breadcrumb" });

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

    return { id, name, projectId: project.id, path: `/projects/${project.id}/${id}` };
}

async function deploy(page: Page, path: string) {
    await page.goto(path);
    const button = page.getByRole("button", { name: /^Deploy/u });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page).toHaveURL(/\/deployments\/[\w-]+$/u);
}

test.beforeEach(async () => {
    await resetSidecar();
});

test("a deploy streams to ready, then the resource shows its running container", async ({
    page,
}) => {
    const target = await resource(page);
    await page.goto(target.path);
    await expect(page.getByRole("button", { name: /undeployed changes/u })).toBeVisible();
    await deploy(page, target.path);

    await expect(page.getByRole("heading", { name: "Resource deployment" })).toBeVisible();
    await expect(status(page)).toHaveText("Ready");
    await expect(page.getByText(/Started .*web/u).first()).toBeVisible();

    const [compose] = await receivedComposes();
    expect(compose).toContain("image: nginx:alpine");

    await page.goto(target.path);
    await expect(page.getByLabel(/^Health: /u)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Deploy$/u })).toBeVisible();

    // It is in the resource's history and the organization-wide list.
    await page.goto(`${target.path}/deployments`);
    await expect(page.getByRole("row").filter({ hasText: "Ready" })).toHaveCount(1);
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

    const second = await page.request.post("/rpc/resources/deploy", {
        data: { json: { projectId: target.projectId, resourceId: target.id } },
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

    await page.goto(`${target.path}/logs`);
    await expect(breadcrumb(page)).toContainText(target.name);

    for (const line of LOG_LINES) await expect(page.getByText(line).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
});

test.describe("deleting", () => {
    const confirmDialog = (page: Page) => page.getByRole("alertdialog");

    /** Whether the fake cluster still runs a service of this resource. */
    async function runsServiceOf(resourceId: string) {
        return (await runningServices()).some((name) => name.includes(resourceId.slice(0, 8)));
    }

    async function deleteResource(page: Page, path: string) {
        await page.goto(`${path}/settings`);
        await page.getByRole("button", { name: "Delete resource" }).click();
        await expect(confirmDialog(page)).toContainText("Volumes stay on the machines.");
        await confirmDialog(page).getByRole("button", { name: "Delete resource" }).click();
    }

    test("a deployed resource's services stop and the resource is gone", async ({ page }) => {
        const target = await resource(page);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Ready");
        expect(await runsServiceOf(target.id)).toBe(true);

        await deleteResource(page, target.path);

        await expect(page).toHaveURL(new RegExp(`/projects/${target.projectId}$`, "u"));
        expect(await runsServiceOf(target.id)).toBe(false);
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toEqual([]);
        expect(await sql("SELECT id FROM deployments WHERE resource_id = $1", [target.id])).toEqual(
            [],
        );
    });

    test("a never-deployed resource is simply removed", async ({ page }) => {
        const target = await resource(page);
        await deleteResource(page, target.path);

        await expect(page).toHaveURL(new RegExp(`/projects/${target.projectId}$`, "u"));
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toEqual([]);
    });

    test("a resource that is still deploying is kept", async ({ page }) => {
        const target = await resource(page, HANGING_IMAGE);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Running");
        const deployment = page.url();

        await deleteResource(page, target.path);
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

        await deleteResource(page, target.path);

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

        await deleteResource(page, target.path);

        await expect(confirmDialog(page)).toContainText(`"user-${created}" still references`);
        expect(await sql("SELECT id FROM resources WHERE id = $1", [target.id])).toHaveLength(1);
    });

    test("deleting a project removes its resources and their services", async ({ page }) => {
        const target = await resource(page);
        await deploy(page, target.path);
        await expect(status(page)).toHaveText("Ready");

        await page.goto(`/projects/${target.projectId}`);
        await page.getByRole("button", { name: "Edit project" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
        await expect(confirmDialog(page)).toContainText("This cannot be undone.");
        await confirmDialog(page).getByRole("button", { name: "Delete project" }).click();

        await expect(page).toHaveURL(/\/projects$/u);
        expect(await runsServiceOf(target.id)).toBe(false);
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

        const refused = await page.request.post("/rpc/projects/deleteProject", {
            data: { json: { projectId: target.projectId } },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(refused.status()).toBe(409);
        expect(await refused.text()).toContain('Delete the S3 bucket \\"keep\\"');
        expect(await sql("SELECT id FROM projects WHERE id = $1", [target.projectId])).toHaveLength(
            1,
        );
    });
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("deploying is left to admins", async ({ page }) => {
        const [api] = await sql<{ id: string; project_id: string }>(
            "SELECT id, project_id FROM resources WHERE name = 'api'",
        );

        await page.goto(`/projects/${api!.project_id}/${api!.id}`);
        await expect(page.locator(".cm-content")).toContainText("nginx:alpine");
        await expect(page.getByRole("button", { name: /^Deploy/u })).toHaveCount(0);

        const refused = await page.request.post("/rpc/resources/deploy", {
            data: { json: { projectId: api!.project_id, resourceId: api!.id } },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(refused.status()).toBe(403);
    });

    test("deleting is left to admins", async ({ page }) => {
        const [api] = await sql<{ id: string; project_id: string }>(
            "SELECT id, project_id FROM resources WHERE name = 'api'",
        );

        await page.goto(`/projects/${api!.project_id}/${api!.id}/settings`);
        await expect(page.getByRole("textbox", { name: /^Name/u })).toBeVisible();
        await expect(page.getByRole("button", { name: "Delete resource" })).toHaveCount(0);

        await page.getByRole("button", { name: "Edit project" }).click();
        await expect(
            page.getByRole("dialog").getByRole("button", { name: "Delete project" }),
        ).toHaveCount(0);

        for (const [path, input] of [
            ["resources/deleteResource", { projectId: api!.project_id, resourceId: api!.id }],
            ["projects/deleteProject", { projectId: api!.project_id }],
        ] as const) {
            const refused = await page.request.post(`/rpc/${path}`, {
                data: { json: input },
                headers: { origin: process.env.E2E_BASE_URL! },
            });

            expect(refused.status()).toBe(403);
        }
    });
});
