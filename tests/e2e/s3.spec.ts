import { readFileSync } from "node:fs";
import { Agent, get } from "node:https";
import {
    HeadBucketCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { expect, test, type Page } from "@playwright/test";
import { ids, memberStorageState, rpc, rustfsCaFile, rustfsRoot, sql } from "./fixtures";

const dialog = (page: Page) => page.getByRole("dialog");

const confirmDialog = (page: Page) => page.getByRole("alertdialog");

type Credentials = { accessKey: string; secretKey: string };

/** Talks to RustFS directly, to check what the app did there. */
function s3(credentials: Credentials = rustfsRoot) {
    return new S3Client({
        endpoint: process.env.E2E_RUSTFS_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
            accessKeyId: credentials.accessKey,
            secretAccessKey: credentials.secretKey,
        },
        maxAttempts: 1,
        requestHandler: { httpsAgent: new Agent({ ca: readFileSync(rustfsCaFile) }) },
    });
}

/** Fetches a URL on RustFS from the test process, which trusts its certificate. */
function fetchFromRustfs(url: string) {
    return new Promise<string>((done, fail) => {
        get(url, { agent: new Agent({ ca: readFileSync(rustfsCaFile) }) }, (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => done(body));
        }).on("error", fail);
    });
}

async function bucketExists(bucket: string) {
    try {
        await s3().send(new HeadBucketCommand({ Bucket: bucket }));

        return true;
    } catch (error) {
        if (error instanceof Error && error.name === "NotFound") return false;
        throw error;
    }
}

let created = 0;

function unique(prefix: string) {
    created += 1;

    return `${prefix}-${Date.now()}-${created}`;
}

async function connection(page: Page) {
    await page.goto("/s3");
    const name = unique("RustFS");

    const { id } = await rpc(page, "s3/create", {
        name,
        connection: {
            provider: "rustfs",
            endpoint: process.env.E2E_RUSTFS_ENDPOINT!,
            ...rustfsRoot,
        },
    });

    return { id, name };
}

/** A bucket created through the API and reconciled by the worker. */
async function readyBucket(page: Page) {
    const { id: connectionId } = await connection(page);
    const bucket = unique("e2e");

    const { id } = await rpc(page, "buckets/create", {
        projectId: ids.shop,
        connectionId,
        name: bucket,
        bucket,
    });

    await expect.poll(() => bucketStatus(id)).toBe("ready");

    return { id, bucket, connectionId, path: `/projects/${ids.shop}/${id}` };
}

async function bucketStatus(resourceId: string) {
    const [row] = await sql<{ status: string }>(
        "SELECT status FROM s3_buckets WHERE resource_id = $1",
        [resourceId],
    );

    return row?.status;
}

/** The bucket keys its Variables tab reveals. */
async function shownCredentials(page: Page, path: string) {
    await page.goto(`${path}/variables`);
    await page.getByRole("button", { name: "Show values" }).click();
    await expect(page.getByRole("button", { name: "Hide values" })).toBeVisible();
    const lines = await page.getByText(/^S3_[A-Z_]+=/u).allTextContents();

    const values = Object.fromEntries(
        lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

    return { accessKey: values.S3_ACCESS_KEY_ID!, secretKey: values.S3_SECRET_ACCESS_KEY! };
}

test.describe("connections", () => {
    test("a RustFS connection is tested and created in a dialog", async ({ page }) => {
        const name = unique("Storage");
        await page.goto("/s3");
        await page.getByRole("button", { name: "Add connection" }).click();

        await dialog(page).locator("#s3-provider").click();
        await page.getByRole("option", { name: "RustFS" }).click();
        await dialog(page).getByLabel("Name").fill(name);
        await dialog(page).getByLabel("Endpoint").fill(process.env.E2E_RUSTFS_ENDPOINT!);
        await dialog(page).getByLabel("Access key").fill(rustfsRoot.accessKey);
        await dialog(page).getByLabel("Secret key").fill("not-the-secret");

        await dialog(page).getByRole("button", { name: "Test connection" }).click();
        await expect(
            dialog(page).getByRole("alert").or(dialog(page).getByRole("status")),
        ).toContainText(/credentials|denied|failed|signature/iu);

        await dialog(page).getByLabel("Secret key").fill(rustfsRoot.secretKey);
        await dialog(page).getByRole("button", { name: "Test connection" }).click();
        await expect(dialog(page).getByRole("status")).toBeVisible();
        await expect(dialog(page).getByRole("alert")).toHaveCount(0);

        await dialog(page).getByRole("button", { name: "Create connection" }).click();
        await expect(dialog(page)).toHaveCount(0);
        // The new connection opens right away.
        await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
        await expect(page.getByText("No buckets yet.")).toBeVisible();
    });

    test("a loopback endpoint is refused", async ({ page }) => {
        await page.goto("/s3");

        const response = await page.request.post("/rpc/s3/create", {
            data: {
                json: {
                    name: unique("Sneaky"),
                    connection: {
                        provider: "rustfs",
                        endpoint: "https://127.0.0.1:9000",
                        ...rustfsRoot,
                    },
                },
            },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(response.ok()).toBe(false);
    });

    test("a connection with buckets is kept; an empty one is deleted", async ({ page }) => {
        const { connectionId, path } = await readyBucket(page);
        await page.goto(`/s3/${connectionId}`);
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await confirmDialog(page)
            .getByRole("button", { name: /delete/iu })
            .click();
        await expect(confirmDialog(page)).toContainText(
            "Delete the buckets provisioned from this connection first.",
        );
        await confirmDialog(page).getByRole("button", { name: "Cancel" }).click();

        // Without its bucket it goes.
        await page.goto(`${path}/settings`);
        await page.getByRole("button", { name: "Delete bucket" }).click();
        await confirmDialog(page).getByRole("button", { name: "Delete bucket" }).click();
        await expect.poll(() => bucketStatus(path.split("/").at(-1)!)).toBeUndefined();

        await page.goto(`/s3/${connectionId}`);
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await confirmDialog(page)
            .getByRole("button", { name: /delete/iu })
            .click();
        await expect(page).toHaveURL(/\/s3$/u);
        expect(await sql("SELECT id FROM s3_connections WHERE id = $1", [connectionId])).toEqual(
            [],
        );
    });
});

test.describe("buckets", () => {
    test("a bucket is created from a project and provisioned at the provider", async ({ page }) => {
        const { name: connectionName } = await connection(page);
        const bucket = unique("uploads");
        await page.goto(`/projects/${ids.shop}/create/bucket`);

        await page.locator("#bucket-name").fill(bucket);
        await page.locator("#bucket-connection").click();
        await page.getByRole("option", { name: connectionName }).click();
        await page.getByLabel("Bucket name").fill(bucket);
        await page.getByRole("button", { name: "Create bucket" }).click();

        await expect(page).toHaveURL(new RegExp(`/projects/${ids.shop}/[\\w-]+$`, "u"));
        const resourceId = new URL(page.url()).pathname.split("/").at(-1)!;
        await expect.poll(() => bucketStatus(resourceId)).toBe("ready");
        expect(await bucketExists(bucket)).toBe(true);
    });

    test("its keys reach only its own bucket, and files show up in the app", async ({ page }) => {
        const { bucket, path } = await readyBucket(page);
        const keys = await shownCredentials(page, path);
        expect(keys.accessKey).toBeTruthy();

        await s3(keys).send(
            new PutObjectCommand({ Bucket: bucket, Key: "hello.txt", Body: "hi from e2e" }),
        );
        // Another bucket on the same provider is out of reach.
        await expect(
            s3(keys).send(new ListObjectsV2Command({ Bucket: "assets" })),
        ).rejects.toThrow();

        await page.goto(path);
        const files = page.getByRole("region", { name: "Files" });
        await expect(files.getByText("hello.txt")).toBeVisible();

        // Download sends the browser to a presigned URL that serves the file.
        const presigned = page.waitForRequest((sent) => sent.url().includes("X-Amz-Signature"));
        await files.getByRole("button", { name: "Download hello.txt" }).click();
        expect(await fetchFromRustfs((await presigned).url())).toBe("hi from e2e");
    });

    test("a storage limit is set in a dialog", async ({ page }) => {
        const { id, path } = await readyBucket(page);
        await page.goto(`${path}/settings`);

        await page.getByRole("button", { name: "Set limit" }).click();
        await dialog(page).getByLabel("Limit (GiB)").fill("2");
        await dialog(page).getByRole("button", { name: /save/iu }).click();
        await expect(dialog(page)).toHaveCount(0);

        await expect(page.getByRole("heading", { name: "2 GiB" })).toBeVisible();
        expect(
            await sql("SELECT quota::text AS quota FROM s3_buckets WHERE resource_id = $1", [id]),
        ).toEqual([{ quota: String(2 * 1024 ** 3) }]);
    });

    test("deleting a bucket revokes its keys and removes the empty bucket", async ({ page }) => {
        const { id, bucket, path } = await readyBucket(page);
        const keys = await shownCredentials(page, path);

        await page.goto(`${path}/settings`);
        await page.getByRole("button", { name: "Delete bucket" }).click();
        await expect(confirmDialog(page)).toContainText("revokes this bucket's keys");
        await confirmDialog(page).getByRole("button", { name: "Delete bucket" }).click();

        await expect.poll(() => bucketStatus(id)).toBeUndefined();
        expect(await sql("SELECT id FROM resources WHERE id = $1", [id])).toEqual([]);
        expect(await bucketExists(bucket)).toBe(false);
        await expect(s3(keys).send(new ListObjectsV2Command({ Bucket: bucket }))).rejects.toThrow();
    });
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("connections and buckets are read-only", async ({ page }) => {
        await page.goto("/s3");
        await expect(page.getByRole("link", { name: /^RustFS RustFS/u })).toBeVisible();
        await expect(page.getByRole("button", { name: "Add connection" })).toHaveCount(0);

        const [assets] = await sql<{ id: string }>(
            "SELECT id FROM resources WHERE project_id = $1 AND name = 'assets'",
            [ids.shop],
        );

        await page.goto(`/projects/${ids.shop}/${assets!.id}/variables`);
        await expect(page.getByRole("button", { name: "Show values" })).toHaveCount(0);
        await page.goto(`/projects/${ids.shop}/${assets!.id}/settings`);
        await expect(page.getByRole("button", { name: /Set limit|Edit limit/u })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Delete bucket" })).toHaveCount(0);

        await page.goto(`/projects/${ids.shop}/create`);
        await expect(page.getByRole("link", { name: /S3 bucket/u })).toHaveCount(0);
    });
});
