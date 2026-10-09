import { expect, test, type Page, type Response } from "@playwright/test";
import * as v from "valibot";
import { assetsId, ids, memberStorageState, resetData, sql } from "./fixtures";

/** Where the crawl starts; everything else is found by following links. */
const entryPoints = (assets: string) => [
    "/",
    "/projects",
    "/clusters",
    `/clusters/${ids.mainCluster}`,
    "/deployments",
    "/observability",
    "/s3",
    "/git",
    "/settings",
    "/admin/settings",
    `/projects/${ids.shop}`,
    `/projects/${ids.shop}/create`,
    `/projects/${ids.shop}/${ids.api}`,
    `/projects/${ids.shop}/${assets}`,
];

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * Ids of what global setup seeded, plus the deployments of those resources. Other specs add
 * their own clusters and projects; following those would make the crawl depend on spec order.
 */
async function seededIds() {
    const seeded = Object.values(ids);

    const rows = await sql<{ id: string }>(
        `SELECT id::text FROM resources WHERE project_id::text = ANY($1::text[])
         UNION SELECT id::text FROM deployments WHERE resource_id::text = ANY($1::text[])
            OR cluster_id::text = ANY($1::text[])
         UNION SELECT id::text FROM s3_connections WHERE name = 'RustFS'`,
        [`{${seeded.join(",")}}`],
    );

    return new Set([...seeded, ...rows.map((row) => row.id)]);
}

/** Same-origin pages of seeded data only: no API, OAuth redirects, downloads, or sign-out. */
function crawlable(href: string, origin: string, allowed: Set<string>) {
    const url = new URL(href, origin);

    return (
        url.origin === origin &&
        !/^\/(api|rpc|git\/oauth|api-reference\/spec\.json)(\/|$)/u.test(url.pathname) &&
        (url.pathname.match(uuid) ?? []).every((id) => allowed.has(id.toLowerCase()))
    );
}

/**
 * Visits one page and returns what went wrong there, plus the links it found.
 *
 * 412 is how the API says "set up monitoring first"; pages show that as an empty state, so
 * those responses (and the query cache logging their message) are not failures. Chrome's own
 * "Failed to load resource" line is skipped because every failing response is recorded.
 */
async function visit(page: Page, path: string) {
    const problems: string[] = [];
    const consoleErrors: string[] = [];
    const expected = new Set<string>();
    const pending: Promise<void>[] = [];

    const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
            consoleErrors.push(message.text());
    };

    const onResponse = (response: Response) => {
        const status = response.status();

        if (status < 400) return;

        if (status !== 412) {
            problems.push(`HTTP ${status} ${new URL(response.url()).pathname}`);

            return;
        }

        pending.push(
            response.json().then(
                (body) => {
                    const error = v.safeParse(
                        v.object({ json: v.object({ message: v.string() }) }),
                        body,
                    );

                    if (error.success) expected.add(`Error: ${error.output.json.message}`);
                },
                () => {},
            ),
        );
    };

    const onPageError = (error: Error) => problems.push(`page error: ${error.message}`);
    page.on("console", onConsole);
    page.on("response", onResponse);
    page.on("pageerror", onPageError);

    try {
        await page.goto(path);

        // Let queries settle: a page is done once no placeholder is left.
        await expect(page.locator("phantom-ui[loading]"))
            .toHaveCount(0, { timeout: 10_000 })
            .catch(() => problems.push("still loading after 10s"));

        const links = await page
            .locator("a[href]")
            .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));

        await Promise.all(pending);

        for (const text of consoleErrors)
            if (!expected.has(text)) problems.push(`console: ${text}`);

        return { problems, links };
    } finally {
        page.off("console", onConsole);
        page.off("response", onResponse);
        page.off("pageerror", onPageError);
    }
}

test.beforeAll(async ({ browser }) => {
    await resetData();

    // A finished deployment, so deployment pages and their links exist.
    const page = await browser.newPage();
    await page.goto(`/projects/${ids.lonely}/${ids.solo}`);
    await page.getByRole("button", { name: "Deploy" }).first().click();
    await expect
        .poll(
            async () =>
                (await sql<{ status: string }>("SELECT status FROM deployments"))[0]?.status,
        )
        .toBe("ready");
    await page.close();
});

/**
 * Follows every same-origin link from the entry points and returns the problems per page.
 * Paths are compared without their query, so list filters do not multiply the crawl.
 */
async function crawl(page: Page, starts: string[]) {
    const origin = new URL(process.env.E2E_BASE_URL!).origin;
    const allowed = await seededIds();
    const queue = [...starts];
    const seen = new Set(queue);
    const failures: Record<string, string[]> = {};

    while (queue.length) {
        const path = queue.shift()!;
        const { problems, links } = await visit(page, path);

        if (problems.length) failures[path] = problems;

        for (const href of links) {
            if (!crawlable(href, origin, allowed)) continue;
            const pathname = new URL(href, origin).pathname;

            if (seen.has(pathname)) continue;
            seen.add(pathname);
            queue.push(pathname);
        }
    }

    return { failures, visited: seen.size };
}

test("every page an owner can reach loads without errors", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    const starts = entryPoints(await assetsId());
    const { failures, visited } = await crawl(page, starts);

    expect(failures).toEqual({});
    // Guards against the crawl silently finding nothing.
    expect(visited).toBeGreaterThan(starts.length);
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    // A 403 here means a page called an admin-only procedure for someone who cannot use it.
    test("every page a member can reach loads without errors", async ({ page }) => {
        test.setTimeout(5 * 60_000);
        const starts = entryPoints(await assetsId()).filter((path) => !path.startsWith("/admin"));
        const { failures, visited } = await crawl(page, starts);

        expect(failures).toEqual({});
        expect(visited).toBeGreaterThan(starts.length);
    });
});
