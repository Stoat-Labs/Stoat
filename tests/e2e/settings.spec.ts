import { expect, test, type Page } from "@playwright/test";
import {
    anonymousContext,
    freshAccount,
    memberStorageState,
    newAccount,
    organizationId,
    sql,
} from "./fixtures";

const section = (page: Page, name: string) => page.goto(`/settings?section=${name}`);

/** A dialog's primary button, so "Delete" in a list never matches by mistake. */
const dialog = (page: Page) => page.getByRole("dialog").or(page.getByRole("alertdialog"));

async function rpc(page: Page, path: string, headers: Record<string, string> = {}) {
    return page.request.post(`/rpc/${path}`, {
        data: { json: {} },
        headers: { origin: process.env.E2E_BASE_URL!, ...headers },
    });
}

test.describe("account", () => {
    test("changing your name shows everywhere", async ({ browser }) => {
        const { account, context, page } = await freshAccount(browser);
        await page.goto("/settings");

        await page.getByLabel("Full name").fill("Renamed Person");
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Profile updated.")).toBeVisible();

        await page.reload();
        await expect(
            page.getByRole("button", { name: "Account menu for Renamed Person" }),
        ).toBeVisible();
        expect(await sql(`SELECT name FROM "user" WHERE email = $1`, [account.email])).toEqual([
            { name: "Renamed Person" },
        ]);
        await context.close();
    });

    test("changing your password checks the old one and signs out other sessions", async ({
        browser,
    }) => {
        const { account, context, page } = await freshAccount(browser);
        // A second session for the same account, e.g. another browser.
        const other = await anonymousContext(browser);
        await other.request.post("/api/auth/sign-in/email", {
            data: { email: account.email, password: account.password },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        await section(page, "security");
        await page.getByLabel("Current password").fill("not-my-password");
        await page.getByLabel("New password", { exact: true }).fill("a-brand-new-password");
        await page.getByLabel("Confirm new password").fill("something-else");
        await expect(page.getByText("Passwords do not match.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Change password" })).toBeDisabled();

        await page.getByLabel("Confirm new password").fill("a-brand-new-password");
        await page.getByRole("button", { name: "Change password" }).click();
        await expect(page.getByRole("alert")).toContainText(/password/iu);

        await page.getByLabel("Current password").fill(account.password);
        await page.getByRole("button", { name: "Change password" }).click();
        await expect(page.getByText("Password changed.")).toBeVisible();

        // The other session is signed out right away; this one still works.
        const otherPage = await other.newPage();
        await otherPage.goto("/projects");
        await expect(otherPage).toHaveURL(/\/login/u);
        const response = await other.request.post("/rpc/projects/listProjects", {
            data: { json: {} },
            headers: { origin: process.env.E2E_BASE_URL! },
        });
        expect(response.status()).toBe(401);
        await page.goto("/projects");
        await expect(page).toHaveURL(/\/projects$/u);

        // Only the new password logs in.
        const visitor = await anonymousContext(browser);
        const loginPage = await visitor.newPage();
        await loginPage.goto("/login");
        await loginPage.getByLabel("Email").fill(account.email);
        await loginPage.getByLabel("Password").fill(account.password);
        await loginPage.getByRole("button", { name: "Log in" }).click();
        await expect(loginPage.getByRole("alert")).toBeVisible();
        await loginPage.getByLabel("Password").fill("a-brand-new-password");
        await loginPage.getByRole("button", { name: "Log in" }).click();
        await expect(loginPage).toHaveURL(/\/$/u);

        await Promise.all([context.close(), other.close(), visitor.close()]);
    });
});

test.describe("organization", () => {
    test("an owner can rename the organization", async ({ browser }) => {
        const { context, page, organizationId } = await freshAccount(browser);
        await section(page, "organization");

        await page.getByLabel("Name").fill("Renamed Org");
        await page.getByLabel("Slug").fill("renamed-org-" + organizationId.slice(0, 8));
        await page.getByRole("button", { name: "Save changes" }).click();
        await expect(page.getByText("Organization updated.")).toBeVisible();

        expect(
            await sql("SELECT name, slug FROM organization WHERE id = $1", [organizationId]),
        ).toEqual([{ name: "Renamed Org", slug: `renamed-org-${organizationId.slice(0, 8)}` }]);
        await context.close();
    });

    test("an invited person joins with the invited role, and can be removed", async ({
        browser,
    }) => {
        const owner = await freshAccount(browser);
        const invitee = newAccount();
        await section(owner.page, "members");

        await owner.page.getByRole("button", { name: "Invite member" }).click();
        await dialog(owner.page).getByLabel("Email").fill(invitee.email);
        await dialog(owner.page).getByRole("combobox", { name: "Role" }).click();
        await owner.page.getByRole("option", { name: "Admin" }).click();
        await dialog(owner.page).getByRole("button", { name: "Create invite" }).click();

        const link = dialog(owner.page).getByText(/\/invite\/[\w-]+/u);
        await expect(link).toBeVisible();
        const invitePath = new URL((await link.textContent())!.trim()).pathname;
        await dialog(owner.page).getByRole("button", { name: "Done" }).click();
        await expect(owner.page.getByText(invitee.email)).toBeVisible();
        await expect(owner.page.getByText("Pending")).toBeVisible();

        // The link survives logging in and signing up on the way.
        const guest = await anonymousContext(browser);
        const page = await guest.newPage();
        await page.goto(invitePath);
        await expect(page).toHaveURL(/\/login\?next=/u);
        await page.getByRole("link", { name: "Create an account" }).click();
        await page.getByLabel("Full name").fill(invitee.name);
        await page.getByLabel("Email").fill(invitee.email);
        await page.getByLabel("Password").fill(invitee.password);
        await page.getByRole("button", { name: "Create account" }).click();

        await expect(page).toHaveURL(new RegExp(`${invitePath}$`, "u"));
        await expect(page.getByText(`invited you to join`)).toContainText("as admin");
        await page.getByRole("button", { name: "Accept invitation" }).click();
        await expect(page).toHaveURL(/\/$/u);

        expect(
            await sql(
                `SELECT m.role FROM member m JOIN "user" u ON u.id = m.user_id
                 WHERE u.email = $1 AND m.organization_id = $2`,
                [invitee.email, owner.organizationId],
            ),
        ).toEqual([{ role: "admin" }]);

        await owner.page.reload();
        await expect(owner.page.getByText("Pending")).toHaveCount(0);
        await owner.page.getByRole("button", { name: `Actions for ${invitee.name}` }).click();
        await owner.page.getByRole("menuitem", { name: "Remove member" }).click();
        await expect(dialog(owner.page)).toContainText("Remove member?");
        await dialog(owner.page).getByRole("button", { name: "Remove" }).click();
        await expect(owner.page.getByText(invitee.email)).toHaveCount(0);

        expect(
            await sql(
                `SELECT m.id FROM member m JOIN "user" u ON u.id = m.user_id
                 WHERE u.email = $1 AND m.organization_id = $2`,
                [invitee.email, owner.organizationId],
            ),
        ).toEqual([]);
        await Promise.all([owner.context.close(), guest.close()]);
    });

    test("an invitation can be cancelled", async ({ browser }) => {
        const { context, page, organizationId } = await freshAccount(browser);
        const invitee = newAccount();
        await section(page, "members");

        await page.getByRole("button", { name: "Invite member" }).click();
        await dialog(page).getByLabel("Email").fill(invitee.email);
        await dialog(page).getByRole("button", { name: "Create invite" }).click();
        await dialog(page).getByRole("button", { name: "Done" }).click();

        await page
            .getByRole("button", { name: `Actions for invitation to ${invitee.email}` })
            .click();
        await page.getByRole("menuitem", { name: "Cancel invitation" }).click();
        await expect(page.getByText(invitee.email)).toHaveCount(0);
        expect(
            await sql("SELECT status FROM invitation WHERE organization_id = $1", [organizationId]),
        ).toEqual([{ status: "canceled" }]);
        await context.close();
    });

    test("an invitation cannot be accepted by someone else", async ({ browser }) => {
        const owner = await freshAccount(browser);
        await section(owner.page, "members");
        await owner.page.getByRole("button", { name: "Invite member" }).click();
        await dialog(owner.page).getByLabel("Email").fill(newAccount().email);
        await dialog(owner.page).getByRole("button", { name: "Create invite" }).click();
        const link = dialog(owner.page).getByText(/\/invite\/[\w-]+/u);
        const invitePath = new URL((await link.textContent())!.trim()).pathname;

        const stranger = await freshAccount(browser);
        await stranger.page.goto(invitePath);
        await expect(stranger.page.getByRole("alert")).toBeVisible();
        await expect(stranger.page.getByRole("button", { name: "Accept invitation" })).toHaveCount(
            0,
        );
        await Promise.all([owner.context.close(), stranger.context.close()]);
    });
});

test.describe("API keys", () => {
    test("a created key calls the API until it is deleted", async ({ browser }) => {
        const { context, page } = await freshAccount(browser);
        await section(page, "api-keys");
        await expect(page.getByText("No API keys yet")).toBeVisible();

        await page.getByRole("button", { name: "Create key" }).click();
        await dialog(page).getByLabel("Name").fill("CI deploys");
        await dialog(page).getByRole("button", { name: "Create key" }).click();
        await expect(dialog(page)).toContainText("API key created");
        const key = (await dialog(page).locator("code").textContent())!.trim();
        expect(key).toMatch(/^stoat_/u);
        await dialog(page).getByRole("button", { name: "Done" }).click();
        await expect(page.getByText("CI deploys")).toBeVisible();

        const anonymous = await anonymousContext(browser);
        const caller = await anonymous.newPage();
        expect((await rpc(caller, "projects/listProjects")).status()).toBe(401);
        expect((await rpc(caller, "projects/listProjects", { "x-api-key": key })).status()).toBe(
            200,
        );

        await page.getByRole("button", { name: "Actions for CI deploys" }).click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await expect(dialog(page)).toContainText("Delete API key?");
        await dialog(page).getByRole("button", { name: "Delete" }).click();
        await expect(page.getByText("No API keys yet")).toBeVisible();

        expect((await rpc(caller, "projects/listProjects", { "x-api-key": key })).status()).toBe(
            401,
        );
        await Promise.all([context.close(), anonymous.close()]);
    });
});

test.describe("danger zone", () => {
    test("an empty organization can be deleted", async ({ browser }) => {
        const { context, page, organizationId } = await freshAccount(browser);
        await section(page, "danger");

        await page.getByRole("button", { name: "Delete organization" }).click();
        await expect(dialog(page)).toContainText("cannot be undone");
        await dialog(page).getByRole("button", { name: "Delete" }).click();

        await expect(page).toHaveURL(/\/$/u);
        expect(await sql("SELECT id FROM organization WHERE id = $1", [organizationId])).toEqual(
            [],
        );
        await context.close();
    });

    test("an organization that still has clusters is kept", async ({ browser }) => {
        const { context, page, organizationId } = await freshAccount(browser);

        const created = await page.request.post("/rpc/cluster/createCluster", {
            data: {
                json: {
                    name: "Keep me",
                    sidecarUrl: process.env.E2E_SIDECAR_URL!,
                    sidecarToken: "e2e-token",
                },
            },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(created.ok()).toBe(true);
        await section(page, "danger");

        await page.getByRole("button", { name: "Delete organization" }).click();
        await dialog(page).getByRole("button", { name: "Delete" }).click();

        await expect(dialog(page)).toContainText("clusters and S3 connections first");
        expect(await sql("SELECT id FROM organization WHERE id = $1", [organizationId])).toEqual([
            { id: organizationId },
        ]);
        await context.close();
    });
});

test.describe("as a member", () => {
    test.use({ storageState: memberStorageState });

    test("owner-only sections are hidden and settings are read-only", async ({ page }) => {
        await page.goto("/settings");
        const nav = page.getByRole("navigation", { name: "Sections" });
        await expect(nav.getByRole("button", { name: "Members" })).toBeVisible();
        await expect(nav.getByRole("button", { name: "API keys" })).toHaveCount(0);
        await expect(nav.getByRole("button", { name: "Danger zone" })).toHaveCount(0);

        await nav.getByRole("button", { name: "General" }).click();
        await expect(page).toHaveURL(/section=organization/u);
        await expect(page.getByLabel("Name")).toBeDisabled();
        await expect(page.getByText("Only owners can change these settings.")).toBeVisible();

        await nav.getByRole("button", { name: "Members" }).click();
        await expect(page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
    });

    test("an owner-only section in the URL falls back to the profile", async ({ page }) => {
        await section(page, "api-keys");
        await expect(page.getByLabel("Full name")).toBeVisible();
        await expect(page.getByRole("button", { name: "Create key" })).toHaveCount(0);
    });

    test("the API refuses owner-only actions", async ({ page }) => {
        await page.goto("/settings");

        const created = await page.request.post("/api/auth/api-key/create", {
            data: { name: "sneaky", organizationId: await organizationId() },
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(created.ok()).toBe(false);
    });
});
