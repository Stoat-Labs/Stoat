import { expect, test, type Page } from "@playwright/test";
import { ids } from "./fixtures";

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

// A key pressed before the app hydrates has no handler yet, so press until the palette opens.
async function openPalette(page: Page) {
    await expect(async () => {
        await page.keyboard.press("ControlOrMeta+k");
        await expect(palette(page)).toBeVisible({ timeout: 1_000 });
    }).toPass();
}

test("Ctrl+K finds a resource from anywhere and opens it on its canvas", async ({ page }) => {
    await page.goto("/deployments");
    await openPalette(page);

    await palette(page).getByRole("combobox").fill("api");
    await palette(page)
        .getByRole("option", { name: /^api\s+Shop$/u })
        .click();

    await expect(page).toHaveURL(new RegExp(`/projects/${ids.shop}/canvas\\?node=${ids.api}`, "u"));
    await expect(palette(page)).toBeHidden();
});

test("the sidebar's Search button opens it, and Enter picks the highlighted project", async ({
    page,
}) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Search" }).click();

    await palette(page).getByRole("combobox").fill("Shop");
    await palette(page).getByRole("combobox").press("Enter");

    await expect(page).toHaveURL(new RegExp(`/projects/${ids.shop}/canvas$`, "u"));
});

test("on a canvas, it offers adding to that project", async ({ page }) => {
    await page.goto(`/projects/${ids.shop}/canvas`);
    await openPalette(page);
    await palette(page).getByRole("option", { name: "Add to this project" }).click();

    await expect(page).toHaveURL(/add=root/u);
});
