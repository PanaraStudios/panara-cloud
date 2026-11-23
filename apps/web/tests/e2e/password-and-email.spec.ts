import { expect, test } from "@playwright/test";
import {
	alert,
	createAccount,
	emailCount,
	expectHome,
	PASSWORD,
	signIn,
	signOut,
	uniqueEmail,
	waitForEmail,
} from "./helpers";

const NEW_PASSWORD = "a brand new passphrase 42";

test("forgot password resets it, and the old password stops working", async ({
	page,
}) => {
	const account = await createAccount(page, "reset");
	await signOut(page);

	await page.getByRole("link", { name: "Forgot password?" }).click();
	await expect(
		page.getByRole("heading", { name: "Reset your password" }),
	).toBeVisible();
	await page.getByLabel("Email").fill(account.email);
	await page.getByRole("button", { name: "Send reset link" }).click();
	await expect(page.getByRole("status")).toContainText(account.email);

	const resetLink = await waitForEmail(account.email, "reset");
	await page.goto(resetLink);
	await expect(page).toHaveURL(/\/reset-password\?token=/);
	await expect(
		page.getByRole("heading", { name: "Choose a new password" }),
	).toBeVisible();
	await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
	await page.getByLabel("Confirm new password").fill("something else entirely");
	await page.getByRole("button", { name: "Change password" }).click();
	await expect(alert(page)).toContainText("The passwords don't match.");
	await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
	await page.getByRole("button", { name: "Change password" }).click();
	await expect(page).toHaveURL(/\/login\?notice=reset/);
	await expect(page.getByRole("status")).toContainText(
		"Your password was changed",
	);

	await signIn(page, account.email, PASSWORD);
	await expect(alert(page)).toContainText(
		"The email or password is incorrect.",
	);
	await signIn(page, account.email, NEW_PASSWORD);
	await expectHome(page);

	await page.goto(resetLink);
	await expect(
		page.getByRole("heading", { name: "Reset link unavailable" }),
	).toBeVisible();
});

test("changing the password can sign out other sessions", async ({
	page,
	browser,
}) => {
	const account = await createAccount(page, "change-password");
	const other = await browser.newContext();
	const otherPage = await other.newPage();
	await signIn(otherPage, account.email);
	await expectHome(otherPage);

	await page.goto("/account/security");
	const card = page.locator("form").filter({
		has: page.getByRole("heading", { name: "Password", exact: true }),
	});
	await card.getByLabel("Current", { exact: true }).fill("wrong password here");
	await card.getByLabel("New", { exact: true }).fill(NEW_PASSWORD);
	await card.getByLabel("Confirm", { exact: true }).fill(NEW_PASSWORD);
	await card.getByRole("button", { name: "Change password" }).click();
	await expect(card.getByRole("alert")).toContainText(
		"The password is incorrect.",
	);

	await card.getByLabel("Current", { exact: true }).fill(PASSWORD);
	await expect(
		card.getByRole("checkbox", { name: "Sign out of all other sessions" }),
	).toBeChecked();
	await card.getByRole("button", { name: "Change password" }).click();
	await expect(card.getByRole("status")).toContainText(
		"Your other sessions were signed out",
	);

	await otherPage.goto("/account/profile");
	await expect(otherPage).toHaveURL(/\/login\?next=%2Faccount%2Fprofile/);
	await other.close();

	await page.reload();
	await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
	await signOut(page);
	await signIn(page, account.email, PASSWORD);
	await expect(alert(page)).toContainText(
		"The email or password is incorrect.",
	);
	await signIn(page, account.email, NEW_PASSWORD);
	await expectHome(page);
});

test("changing the email confirms with the old address, then verifies the new one", async ({
	page,
}) => {
	const account = await createAccount(page, "change-email");
	const newEmail = uniqueEmail("changed");
	await page.goto("/account/profile");
	const card = page.locator("section").filter({
		has: page.getByRole("heading", { name: "Email", exact: true }),
	});
	await expect(card).toContainText(account.email);
	await card.getByRole("button", { name: "Change email" }).click();
	const dialog = page.getByRole("dialog", { name: "Change email" });
	await dialog.getByLabel("New email address").fill(account.email);
	await dialog.getByRole("button", { name: "Send confirmation" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"That's already your email address.",
	);
	await dialog.getByLabel("New email address").fill(newEmail);
	await dialog.getByRole("button", { name: "Send confirmation" }).click();
	await expect(dialog).toBeHidden();
	await expect(card.getByRole("status")).toContainText(
		`We sent a confirmation link to ${account.email}`,
	);

	// Nothing changes until the old address confirms.
	const confirmation = await waitForEmail(account.email, "change-email");
	expect(emailCount(newEmail, "verify")).toBe(0);
	await expect(card).toContainText(account.email);

	await page.goto(confirmation);
	await expect(page).toHaveURL(/\/account\/profile$/);
	await page.goto(await waitForEmail(newEmail, "verify"));
	await expect(page).toHaveURL(/\/account\/profile$/);
	await expect(card).toContainText(newEmail);
	await expect(card).toContainText("Verified");

	await signOut(page);
	await signIn(page, newEmail);
	await expect(
		page.getByRole("button", { name: "Account menu" }),
	).toContainText(newEmail);
});
