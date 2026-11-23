import { expect, type Page, test } from "@playwright/test";
import { adminContext } from "./helpers";

// The section lists move the URL with history.pushState instead of a
// navigation (an open form must not remount); the page has to follow it.
async function expectOpen(page: Page, nav: string, title: string) {
	await expect(
		page.getByRole("navigation", { name: nav }).getByRole("link", {
			name: title,
		}),
	).toHaveAttribute("aria-current", "page");
	await expect(
		page.getByRole("heading", { name: title, level: 2, exact: true }),
	).toBeVisible();
}

test("server settings sections open from the list, the keyboard and history", async ({
	browser,
}) => {
	const context = await adminContext(browser);
	const page = await context.newPage();
	// The panel host is in every organization.
	const serverPath = "/servers/local";
	await page.goto(`${serverPath}/settings`);
	const nav = "Settings sections";
	await expectOpen(page, nav, "Setup");

	await page
		.getByRole("navigation", { name: nav })
		.getByRole("link", { name: "Security" })
		.click();
	await expect(page).toHaveURL(new RegExp(`${serverPath}/settings/security$`));
	await expectOpen(page, nav, "Security");

	await page
		.getByRole("navigation", { name: nav })
		.getByRole("link", { name: "Docker & builds" })
		.click();
	await expectOpen(page, nav, "Docker & builds");

	await page.keyboard.press("]");
	await expect(page).toHaveURL(new RegExp(`${serverPath}/settings/gpu$`));
	await expectOpen(page, nav, "GPU");

	await page.goBack();
	await expect(page).toHaveURL(new RegExp(`${serverPath}/settings/docker$`));
	await expectOpen(page, nav, "Docker & builds");
	await context.close();
});

test("API reference groups open from the list", async ({ browser }) => {
	const context = await adminContext(browser);
	const page = await context.newPage();
	await page.goto("/settings/api-keys/reference");
	const nav = page.getByRole("navigation", { name: "API groups" });
	const links = nav.getByRole("link");
	await expect(links.nth(1)).toBeVisible();
	const second = links.nth(1);
	const title = (await second.textContent())?.trim() ?? "";
	await second.click();
	await expect(page).toHaveURL(/[?&]section=/);
	await expect(second).toHaveAttribute("aria-current", "page");
	await expect(
		page.getByRole("heading", { name: title, level: 2, exact: true }),
	).toBeVisible();
	await context.close();
});
