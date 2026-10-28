import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";
import { SIDECAR_DOMAIN } from "./fake-sidecar";
import {
    ids,
    receivedComposes,
    ref,
    resetData,
    routeRpc,
    sql,
    variablesPath,
    waitForRpc,
} from "./fixtures";

const popup = (page: Page) => page.locator('[data-slot="popover-popup"]');

const items = (page: Page) => popup(page).locator('[data-slot="command-item"]');

const groupLabels = (page: Page) => popup(page).locator('[data-slot="command-group-label"]');

const editor = (page: Page) => page.locator(".cm-content");

const chips = (page: Page) => editor(page).locator(".cm-reference-name");

const search = (page: Page) => popup(page).getByRole("combobox");

/** Opens a resource's Variables page once its reference targets have loaded. */
async function openVariables(
    page: Page,
    projectId: string = ids.shop,
    resourceId: string = ids.api,
) {
    const targets = waitForRpc(page, "resources/listVariableReferences");

    await page.goto(variablesPath(projectId, resourceId));
    await expect(editor(page)).toBeVisible();
    await targets;
}

/** Puts the cursor at the end of the .env and types on a new line. */
async function typeOnNewLine(page: Page, text: string) {
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type(text);
}

async function savedEnv(resourceId: string = ids.api) {
    const [row] = await sql<{ env: string | null }>(
        "SELECT settings->>'env' AS env FROM resources WHERE id = $1",
        [resourceId],
    );

    return row?.env;
}

async function save(page: Page) {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Variables saved.")).toBeVisible();
}

/** Searches the open picker and chooses the only match. */
async function choose(page: Page, text: string) {
    await page.keyboard.type(text);
    await expect(items(page)).toHaveCount(1);
    await page.keyboard.press("Enter");
}

test.beforeEach(async () => {
    await resetData();
});

test.describe("picking a reference", () => {
    test("typing {{ opens on this project's resources", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "URL={{");

        await expect(popup(page)).toBeVisible();
        await expect(page.getByLabel("Search resources in Shop")).toBeFocused();
        await expect(groupLabels(page)).toHaveText(["Shop"]);
        // Never itself.
        await expect(items(page)).toHaveText([/^postgres\s+11 variables/u]);
    });

    test("Back lists the projects, and another project's resources can be picked", async ({
        page,
    }) => {
        await openVariables(page);
        await typeOnNewLine(page, "QUEUE={{");
        await popup(page).getByRole("button", { name: "Back" }).click();

        await expect(page.getByLabel("Search projects")).toBeFocused();
        // Never buckets, other clusters, or internal projects.
        await expect(items(page)).toHaveText([
            /^Shop \(this project\)\s+1 resource/u,
            /^Jobs\s+1 resource/u,
        ]);

        await items(page).filter({ hasText: "Jobs" }).click();
        await expect(page.getByLabel("Search resources in Jobs")).toBeFocused();
        await items(page).filter({ hasText: "worker" }).click();
        await expect(page.getByLabel("Search variables in worker")).toBeFocused();
        await items(page)
            .filter({ hasText: /^\s*QUEUE\s*$/u })
            .click();

        await expect(popup(page)).toHaveCount(0);
        await expect(chips(page)).toHaveText(["worker.QUEUE"]);
        await save(page);
        expect(await savedEnv()).toBe(`PORT=3000\nQUEUE=${ref(ids.worker, "QUEUE")}`);
    });

    test("keyboard: resource, then variable, inserts the reference", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "URL={{");
        await choose(page, "post");

        const variables = page.getByLabel("Search variables in postgres");
        await expect(variables).toBeFocused();
        await expect(variables).toHaveValue("");
        await expect(groupLabels(page)).toHaveText(["Variables", "Added by Stoat"]);

        await choose(page, "DATABASE");
        await expect(popup(page)).toHaveCount(0);
        await expect(editor(page)).toBeFocused();
        await expect(chips(page)).toHaveText(["postgres.DATABASE_URL"]);

        // Focus is back in the editor: typing continues the line.
        await page.keyboard.type(" # db");
        await save(page);
        expect(await savedEnv()).toBe(`PORT=3000\nURL=${ref(ids.postgres, "DATABASE_URL")} # db`);
    });

    test("variables set in Compose can be referenced", async ({ page }) => {
        await sql("UPDATE resources SET draft_spec = $2 WHERE id = $1", [
            ids.worker,
            "services:\n  jobs:\n    image: busybox\n    environment:\n      JOBS_TOKEN: t-${QUEUE}\n",
        ]);
        await openVariables(page);
        await typeOnNewLine(page, "TOKEN={{");
        await page.keyboard.press("Backspace");
        await choose(page, "Jobs");
        await choose(page, "worker");
        await expect(groupLabels(page)).toContainText(["Set in Compose"]);
        await choose(page, "JOBS_TOKEN");

        await save(page);
        expect(await savedEnv()).toBe(`PORT=3000\nTOKEN=${ref(ids.worker, "JOBS_TOKEN")}`);
    });

    test("Backspace on an empty search goes up a level", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "URL={{");
        await choose(page, "postgres");
        await expect(page.getByLabel("Search variables in postgres")).toBeFocused();

        // Typed text is deleted first; only an empty search steps back.
        await page.keyboard.type("Q");
        await page.keyboard.press("Backspace");
        await expect(page.getByLabel("Search variables in postgres")).toBeVisible();
        await page.keyboard.press("Backspace");

        await expect(page.getByLabel("Search resources in Shop")).toBeFocused();
        await page.keyboard.press("Backspace");
        await expect(page.getByLabel("Search projects")).toBeFocused();
        await choose(page, "Shop");
        await choose(page, "postgres");
        await choose(page, "POSTGRES_USER");
        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER"]);
    });

    for (const level of ["projects", "resources", "variables"] as const)
        test(`Escape while choosing ${level} closes and keeps the typed {{`, async ({ page }) => {
            await openVariables(page);
            await typeOnNewLine(page, "URL={{");

            if (level === "projects") await page.keyboard.press("Backspace");

            if (level === "variables") await choose(page, "postgres");

            await page.keyboard.press("Escape");

            await expect(popup(page)).toHaveCount(0);
            await expect(editor(page)).toBeFocused();
            await page.keyboard.type("x");
            await expect(editor(page)).toContainText("URL={{x");
            await expect(chips(page)).toHaveCount(0);
        });

    test("Ctrl+Space opens the picker at the cursor without typing {{", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "USER=");
        await page.keyboard.press("Control+Space");
        await choose(page, "postgres");
        await choose(page, "POSTGRES_USER");

        await save(page);
        expect(await savedEnv()).toBe(`PORT=3000\nUSER=${ref(ids.postgres, "POSTGRES_USER")}`);
    });

    test("a single brace does not open the picker", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "JSON={");
        await expect(popup(page)).toHaveCount(0);
        await expect(editor(page)).toBeFocused();
    });

    test("searches that match nothing say so", async ({ page }) => {
        await openVariables(page);
        await typeOnNewLine(page, "URL={{");
        await page.keyboard.type("zzz");
        await expect(popup(page)).toContainText('Nothing matches "zzz".');
    });

    test("a project with nothing else to reference says so, and Back still works", async ({
        page,
    }) => {
        await openVariables(page, ids.lonely, ids.solo);
        await typeOnNewLine(page, "URL={{");
        await expect(popup(page)).toContainText("No other resources in this project.");
        await page.keyboard.press("Backspace");
        await expect(popup(page)).toContainText("No other resources on this cluster yet.");
    });

    test("shows loading while the resources are still on their way", async ({ page }) => {
        let release = () => {};

        const held = new Promise<void>((done) => (release = done));

        await routeRpc(page, "resources/listVariableReferences", (route) => {
            void held.then(route.forward);
        });
        await page.goto(variablesPath(ids.shop, ids.api));
        await typeOnNewLine(page, "URL={{");
        await expect(popup(page)).toContainText("Loading resources...");

        release();
        await expect(items(page)).toHaveText([/^postgres\s+11 variables/u]);
    });

    test("explains a failure to load the resources", async ({ page }) => {
        await routeRpc(page, "resources/listVariableReferences", (route) =>
            route.fulfill(500, {
                json: {
                    defined: false,
                    code: "INTERNAL_SERVER_ERROR",
                    status: 500,
                    message: "boom",
                },
            }),
        );
        await page.goto(variablesPath(ids.shop, ids.api));
        await expect(editor(page)).toBeVisible();
        await typeOnNewLine(page, "URL={{");
        await expect(popup(page)).toContainText("Unable to load resources");
        await expect(popup(page)).not.toContainText("No other resources");
    });
});

test.describe("canvas Variables panel", () => {
    async function openPanel(page: Page) {
        const targets = waitForRpc(page, "resources/listVariableReferences");

        await page.goto(`/projects/${ids.shop}/canvas?node=${ids.api}&tab=variables`);
        await page.getByRole("button", { name: "New Variable" }).click();
        await targets;
    }

    const valueField = (page: Page) => page.getByLabel("Variable value");

    test("the {} button picks a reference by name, and Enter saves it", async ({ page }) => {
        await openPanel(page);
        await page.getByLabel("Variable name").fill("DB_USER");
        await page.getByRole("button", { name: "Reference another resource's variable" }).click();

        await expect(page.getByLabel("Search resources in Shop")).toBeFocused();
        await choose(page, "postgres");
        await choose(page, "POSTGRES_USER");

        await expect(valueField(page)).toBeFocused();
        await expect(valueField(page)).toHaveText("postgres.POSTGRES_USER");
        await expect(valueField(page)).not.toContainText("{{");
        await page.keyboard.press("Enter");

        await expect
            .poll(() => savedEnv())
            .toContain(`DB_USER="${ref(ids.postgres, "POSTGRES_USER")}"`);
    });

    test("Escape in the picker leaves the panel and the new row open", async ({ page }) => {
        await openPanel(page);
        await valueField(page).click();
        await page.keyboard.type("{{");
        await page.keyboard.press("Backspace");
        await expect(page.getByLabel("Search projects")).toBeFocused();
        await page.keyboard.press("Escape");

        await expect(popup(page)).toHaveCount(0);
        await expect(valueField(page)).toBeFocused();
        await expect(page.getByRole("tab", { name: "Variables" })).toBeVisible();
        await expect(page.getByLabel("Variable name")).toBeVisible();
    });

    test("pasted newlines are dropped", async ({ page }) => {
        await openPanel(page);
        await valueField(page).click();
        await page.evaluate(() => {
            const data = new DataTransfer();

            data.setData("text/plain", "token-123\n");
            document
                .querySelector(".cm-content[aria-label='Variable value']")
                ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
        });
        await expect(valueField(page)).toHaveText("token-123");
    });
});

test.describe("references in the editor", () => {
    test("saved references show resource names and survive a reload", async ({ page }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [
                ids.api,
                `A=${ref(ids.postgres, "POSTGRES_USER")}\nB=${ref(ids.worker.toUpperCase(), "QUEUE")}\n`,
            ],
        );
        await openVariables(page);

        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER", "worker.QUEUE"]);
        await expect(editor(page)).not.toContainText(ids.postgres);
        await page.reload();
        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER", "worker.QUEUE"]);
    });

    test("unknown and name-based references are flagged", async ({ page }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [
                ids.api,
                `A=${ref("99999999-2222-4333-8444-555555555555", "KEY")}\nB={{ postgres.KEY }}\nC=${ref(ids.elsewhereResource, "SECRET")}\n`,
            ],
        );
        await openVariables(page);

        await expect(editor(page).locator(".cm-reference-unknown")).toHaveText([
            "{{ 99999999-2222-4333-8444-555555555555.KEY }}",
            "{{ postgres.KEY }}",
            ref(ids.elsewhereResource, "SECRET"),
        ]);
        await expect(chips(page)).toHaveCount(0);
    });

    test("Backspace removes a whole reference at once", async ({ page }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [ids.api, `A=${ref(ids.postgres, "POSTGRES_USER")} # user`],
        );
        await openVariables(page);
        await chips(page).click();
        await page.keyboard.press("End");

        // Step left over " # user", then delete the chip.
        for (let step = 0; step < 7; step++) await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("Backspace");

        await expect(chips(page)).toHaveCount(0);
        await save(page);
        expect(await savedEnv()).toBe("A= # user");
    });

    test("chips stay readable whether values are shown or hidden", async ({ page }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [ids.api, `A=${ref(ids.postgres, "POSTGRES_USER")}`],
        );
        await openVariables(page);
        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER"]);

        await page.getByRole("button", { name: "Show values" }).click();
        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER"]);
        await page.getByRole("button", { name: "Hide values" }).click();
        await expect(chips(page)).toHaveText(["postgres.POSTGRES_USER"]);
    });

    test("read-only internal resources never offer the picker", async ({ page }) => {
        await page.goto(variablesPath(ids.internal, ids.monitoring));
        await expect(editor(page)).toHaveAttribute("aria-readonly", "true");
        await editor(page).click();
        await page.keyboard.type("{{");
        await expect(popup(page)).toHaveCount(0);
    });
});

test.describe("deploying with references", () => {
    async function deploy(page: Page) {
        await page.goto(`/projects/${ids.shop}/${ids.api}`);
        const button = page.getByRole("button", { name: "Deploy" }).first();
        await expect(button).toBeEnabled();
        await button.click();
    }

    test("the cluster receives the referenced values", async ({ page }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [ids.api, `URL=${ref(ids.postgres, "DATABASE_URL")}\n`],
        );
        await deploy(page);

        await expect.poll(receivedComposes).toHaveLength(1);
        const [compose] = await receivedComposes();
        const service = Object.values(parse(compose!).services)[0];

        const [postgres] = await sql<{ slug: string }>("SELECT slug FROM resources WHERE id = $1", [
            ids.postgres,
        ]);

        expect(service).toMatchObject({
            environment: {
                URL: `postgres://shop@${postgres!.slug}-db.internal:5432/shop`,
            },
        });
        await expect
            .poll(
                async () =>
                    (await sql<{ status: string }>("SELECT status FROM deployments"))[0]?.status,
            )
            .toBe("ready");
    });

    test("referenced values keep their dollar signs and see the cluster domain", async ({
        page,
    }) => {
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [ids.postgres, "POSTGRES_PASSWORD='s3cr$$t'\nPUBLIC=https://db.${STOAT_DOMAIN}\n"],
        );
        await sql(
            `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
            [
                ids.api,
                `URL=${ref(ids.postgres, "POSTGRES_PASSWORD")}@${ref(ids.postgres, "PUBLIC")}\n`,
            ],
        );
        await deploy(page);

        await expect.poll(receivedComposes).toHaveLength(1);
        const [compose] = await receivedComposes();
        expect(Object.values(parse(compose!).services)[0]).toMatchObject({
            environment: { URL: `s3cr$$t@https://db.${SIDECAR_DOMAIN}` },
        });
    });

    for (const [name, env, message] of [
        [
            "an unknown resource",
            `URL=${ref("99999999-2222-4333-8444-555555555555", "KEY")}`,
            "does not exist on this cluster",
        ],
        [
            "another cluster",
            `URL=${ref(ids.elsewhereResource, "SECRET")}`,
            "does not exist on this cluster",
        ],
        [
            "an unknown variable",
            `URL=${ref(ids.postgres, "NOPE")}`,
            'Resource "postgres" has no variable NOPE.',
        ],
        ["a resource name", "URL={{ postgres.POSTGRES_USER }}", "Invalid variable reference"],
        ["itself", `URL=${ref(ids.api, "PORT")}`, "points at this resource itself"],
    ] as const)
        test(`a reference to ${name} is refused with a visible reason`, async ({ page }) => {
            await sql(
                `UPDATE resources SET settings = jsonb_build_object('env', $2::text) WHERE id = $1`,
                [ids.api, `${env}\n`],
            );
            await deploy(page);

            await expect(page.getByText(/Unable to deploy:/u)).toContainText(message);
            expect(await sql("SELECT id FROM deployments")).toEqual([]);
            expect(await receivedComposes()).toEqual([]);
        });
});
