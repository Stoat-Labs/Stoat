import { expect, test, type Page } from "@playwright/test";
import {
    anonymousContext,
    clientHeaders,
    ids,
    member,
    memberStorageState,
    newAccount,
    sql,
    storageState,
    user,
} from "./fixtures";

async function signUp(page: Page, account: ReturnType<typeof newAccount>) {
    await page.goto("/signup");
    await page.getByLabel("Full name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
}

async function logIn(page: Page, email: string, password: string) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
}

const accountMenu = (page: Page, name: string) =>
    page.getByRole("button", { name: `Account menu for ${name}` });

test.beforeEach(async ({ page }) => {
    await page.setExtraHTTPHeaders(clientHeaders());
});

test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("app pages send visitors to the login page", async ({ page }) => {
        await page.goto("/projects");
        await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/u);
        await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    });

    test("signing up creates an account with its own organization", async ({ page }) => {
        const account = newAccount();
        await signUp(page, account);

        await expect(page).toHaveURL(/\/$/u);
        await expect(accountMenu(page, account.name)).toBeVisible();

        const organizations = await sql<{ name: string; role: string }>(
            `SELECT o.name, m.role FROM member m
             JOIN organization o ON o.id = m.organization_id
             JOIN "user" u ON u.id = m.user_id WHERE u.email = $1`,
            [account.email],
        );

        expect(organizations).toEqual([{ name: `${account.name}'s organization`, role: "owner" }]);
    });

    test("an email that is already registered is refused", async ({ page }) => {
        await signUp(page, { ...newAccount(), email: user.email });

        await expect(page.getByRole("alert")).toBeVisible();
        await expect(page).toHaveURL(/\/signup$/u);
    });

    test("a wrong password is refused, the right one logs in", async ({ page }) => {
        await page.goto("/login");
        await logIn(page, user.email, "not-the-password");
        await expect(page.getByRole("alert")).toContainText(/invalid/iu);
        await expect(page).toHaveURL(/\/login$/u);

        await logIn(page, user.email, user.password);
        await expect(accountMenu(page, user.name)).toBeVisible();
    });

    test("repeated failed logins slow down that client, not everyone", async ({
        page,
        browser,
    }) => {
        await page.goto("/login");

        for (let attempt = 0; attempt < 4; attempt++)
            await logIn(page, user.email, "not-the-password");
        await expect(page.getByRole("alert")).toContainText(/too many requests/iu);

        // Someone else, at the same moment, is not locked out.
        const other = await anonymousContext(browser);
        const otherPage = await other.newPage();
        await otherPage.goto("/login");
        await logIn(otherPage, user.email, user.password);
        await expect(accountMenu(otherPage, user.name)).toBeVisible();
        await other.close();
    });

    test("a client cannot dodge the limit by claiming another address", async ({ page }) => {
        const client = clientHeaders();
        await page.setExtraHTTPHeaders(client);
        await page.goto("/login");

        for (let attempt = 0; attempt < 4; attempt++) {
            await page.setExtraHTTPHeaders({
                ...client,
                "x-stoat-client-ip": `203.0.113.${attempt}`,
            });
            await logIn(page, user.email, "not-the-password");
        }

        await expect(page.getByRole("alert")).toContainText(/too many requests/iu);
    });

    test("logging in returns to the page that asked for it", async ({ page }) => {
        await page.goto(`/clusters/${ids.mainCluster}?tab=x`);
        await expect(page).toHaveURL(/\/login\?next=/u);
        await logIn(page, user.email, user.password);

        await expect(page).toHaveURL(new RegExp(`/clusters/${ids.mainCluster}\\?tab=x$`, "u"));
    });

    test("an off-site next link is ignored", async ({ page }) => {
        await page.goto("/login?next=%2F%2Fevil.example");
        await logIn(page, user.email, user.password);

        await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/u);
    });

    test("logging out ends the session", async ({ page }) => {
        const account = newAccount();
        await signUp(page, account);
        await accountMenu(page, account.name).click();
        await page.getByRole("menuitem", { name: "Log out" }).click();

        await expect(page).toHaveURL(/\/login$/u);
        await page.goto("/projects");
        await expect(page).toHaveURL(/\/login\?next=/u);
    });
});

test.describe("signed in", () => {
    test("the login and sign-up pages send you home", async ({ page }) => {
        await page.goto("/login");
        await expect(page).toHaveURL(/\/$/u);
        await page.goto("/signup");
        await expect(page).toHaveURL(/\/$/u);
    });
});

test.describe("instance sign-up setting", () => {
    test.use({ storageState });

    test.afterEach(async () => {
        await sql("UPDATE instance_settings SET signups_enabled = true");
    });

    test("an admin can turn sign-ups off and on again", async ({ page, browser }) => {
        await page.goto("/admin/settings");
        const toggle = page.getByRole("switch", { name: "Allow user signups" });
        // The page has a second form (private network access) with the same button label.
        const signupsForm = page.locator("form").filter({ has: toggle });
        const save = signupsForm.getByRole("button", { name: "Save Changes" });
        const saved = signupsForm.getByText("Settings saved.");

        await expect(toggle).toBeChecked();
        await toggle.click();
        await save.click();
        await expect(saved).toBeVisible();

        const visitorContext = await anonymousContext(browser);
        const visitor = await visitorContext.newPage();
        await visitor.goto("/signup");
        await expect(visitor.getByText("User signups are currently disabled.")).toBeVisible();
        await expect(visitor.getByRole("button", { name: "Create account" })).toHaveCount(0);

        // The API refuses too, not just the form.
        const refused = await visitor.request.post("/api/auth/sign-up/email", {
            data: newAccount(),
            headers: { origin: process.env.E2E_BASE_URL! },
        });

        expect(refused.status()).toBe(403);

        await visitor.goto("/login");
        await expect(visitor.getByRole("link", { name: "Create an account" })).toHaveCount(0);

        await page.reload();
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await save.click();
        await expect(saved).toBeVisible();

        await visitor.goto("/signup");
        await expect(visitor.getByRole("button", { name: "Create account" })).toBeVisible();
        await visitorContext.close();
    });
});

test.describe("as a non-admin", () => {
    test.use({ storageState: memberStorageState });

    test("system settings are refused", async ({ page }) => {
        const response = await page.goto("/admin/settings");

        expect(response?.status()).toBe(403);
        await expect(page.getByText("Admins only.")).toBeVisible();
    });

    test("the admin link is not offered", async ({ page }) => {
        await page.goto("/");
        await expect(accountMenu(page, member.name)).toBeVisible();
        await expect(page.locator('a[href^="/admin"]')).toHaveCount(0);
    });
});
