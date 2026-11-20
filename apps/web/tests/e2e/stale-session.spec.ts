import { expect, type Page, test } from "@playwright/test";
import { ageSessions, alert, createAccount, PASSWORD } from "./helpers";

function sessionRows(page: Page) {
	return page.getByRole("table").locator("tbody").getByRole("row");
}

test("sensitive actions on an old session ask the user to sign in again", async ({
	page,
}) => {
	const account = await createAccount(page, "stale");
	ageSessions(account.email);

	// Listing sessions never needs a fresh sign-in.
	await page.goto("/account/sessions");
	await expect(sessionRows(page).first()).toContainText("This device");
	await expect(sessionRows(page)).toHaveCount(1);
	await expect(alert(page)).toHaveCount(0);

	await page.goto("/account/security");
	await page.getByRole("button", { name: "Add a passkey" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Create passkey" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"this needs a recent sign-in",
	);
	await dialog.getByRole("button", { name: "Sign in again" }).click();

	await expect(page).toHaveURL(
		/\/login\?notice=reauth&next=%2Faccount%2Fsecurity/,
	);
	await expect(page.getByRole("status")).toContainText(
		"sign in again to continue",
	);
	await page.getByLabel("Email").fill(account.email);
	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/account\/security$/);
	await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();

	await page.goto("/account/sessions");
	await expect(sessionRows(page).first()).toContainText("This device");
	await expect(sessionRows(page)).toHaveCount(1);
});
