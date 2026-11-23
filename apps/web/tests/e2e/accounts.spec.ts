import { expect, type Page, test } from "@playwright/test";
import {
	adminContext,
	alert,
	expectHome,
	fillSignUp,
	PASSWORD,
	signIn,
	uniqueEmail,
} from "./helpers";

// The members page is Convex-backed, so it runs in a browser signed in with
// the admin API context's session.
async function openMembers(page: Page) {
	await page.goto("/settings/members");
	await expect(
		page.getByRole("heading", { name: "Members", level: 1 }),
	).toBeVisible();
}

// The members table comes first; the invitations table may list the email too.
function memberRow(page: Page, email: string) {
	return page.getByRole("table").first().getByRole("row").filter({
		hasText: email,
	});
}

async function rowAction(page: Page, email: string, action: string) {
	await memberRow(page, email)
		.getByRole("button", { name: "Open menu" })
		.click();
	await page.getByRole("menuitem", { name: action }).click();
}

async function confirmRowAction(page: Page, email: string, action: string) {
	await rowAction(page, email, action);
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: action })
		.click();
	await expect(page.getByRole("alertdialog")).toBeHidden();
	// The row's actions menu stays open behind the confirmation and hides
	// the page from role queries until closed.
	// Deleting the row's account closes its menu by itself: it can be gone
	// between the look and the key press, which must not wait for it.
	const menu = page.getByRole("menu");
	if (await menu.isVisible()) {
		await menu.press("Escape", { timeout: 2000 }).catch(() => {});
	}
	await expect(menu).toBeHidden();
}

async function createWithInitialPassword(page: Page, email: string) {
	await page.getByRole("button", { name: "Invite member" }).click();
	const dialog = page.getByRole("dialog", { name: "Invite member" });
	await dialog.getByLabel("Email").fill(email);
	await dialog.getByRole("radio", { name: /Initial password/ }).click();
	await dialog.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await dialog.getByLabel("Confirm", { exact: true }).fill(PASSWORD);
	await dialog.getByRole("button", { name: "Create member" }).click();
	await expect(
		page.getByText("User created with initial credentials"),
	).toBeVisible();
	await expect(dialog).toBeHidden();
	await expect(memberRow(page, email)).toContainText("Active");
}

test("an admin creates a user with initial credentials, deactivates and reactivates it", async ({
	browser,
}) => {
	const email = uniqueEmail("credentials");
	const admin = await adminContext(browser);
	const page = await admin.newPage();
	await openMembers(page);
	await createWithInitialPassword(page, email);

	// No email verification: the admin vouched for the address.
	const other = await browser.newContext();
	const userPage = await other.newPage();
	await signIn(userPage, email);
	await expectHome(userPage);

	await confirmRowAction(page, email, "Deactivate user");
	await expect(memberRow(page, email)).toContainText("Deactivated");

	// Deactivating signs the user out everywhere and blocks new sign-ins.
	await userPage.goto("/account/profile");
	await expect(userPage).toHaveURL(/\/login/);
	await signIn(userPage, email);
	await expect(alert(userPage)).toContainText("deactivated");

	await confirmRowAction(page, email, "Reactivate user");
	await expect(memberRow(page, email)).toContainText("Active");
	await signIn(userPage, email);
	await expectHome(userPage);

	await confirmRowAction(page, email, "Delete account");
	await expect(memberRow(page, email)).toHaveCount(0);
	await other.close();
	await admin.close();
});

test("an admin hands a member a one-time password reset link", async ({
	browser,
}) => {
	const email = uniqueEmail("reset-link");
	const NEW_PASSWORD = "another long password";
	const admin = await adminContext(browser);
	const page = await admin.newPage();
	await openMembers(page);
	await createWithInitialPassword(page, email);

	await rowAction(page, email, "Reset password link");
	const dialog = page.getByRole("dialog", { name: "Reset password link" });
	await dialog.getByRole("button", { name: "Create link" }).click();
	const field = dialog.getByRole("textbox", { name: "Reset link" });
	await expect(field).toHaveValue(/\/reset-password\?token=/);
	await expect(
		dialog.getByRole("button", { name: "Copy Reset link" }),
	).toBeVisible();
	const link = await field.inputValue();

	const userPage = await (await browser.newContext()).newPage();
	await userPage.goto(link);
	await userPage.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
	await userPage.getByLabel("Confirm new password").fill(NEW_PASSWORD);
	await userPage.getByRole("button", { name: "Change password" }).click();
	await expect(userPage).toHaveURL(/\/login\?notice=reset/);
	await signIn(userPage, email, PASSWORD);
	await expect(alert(userPage)).toContainText(
		"The email or password is incorrect.",
	);
	await signIn(userPage, email, NEW_PASSWORD);
	await expectHome(userPage);

	// The link works once: the token is checked when the form is sent.
	await userPage.goto(link);
	await userPage.getByLabel("New password", { exact: true }).fill(PASSWORD);
	await userPage.getByLabel("Confirm new password").fill(PASSWORD);
	await userPage.getByRole("button", { name: "Change password" }).click();
	await expect(
		userPage.getByRole("heading", { name: "Reset link unavailable" }),
	).toBeVisible();
	await admin.close();
});

test("an admin invites a member and hands over the copied invitation link", async ({
	browser,
}) => {
	const email = uniqueEmail("ui-invite");
	const admin = await adminContext(browser);
	const page = await admin.newPage();
	await openMembers(page);

	await page.getByRole("button", { name: "Invite member" }).click();
	const dialog = page.getByRole("dialog", { name: "Invite member" });
	await dialog.getByLabel("Email").fill(email);
	await expect(
		dialog.getByRole("radio", { name: /Invitation link/ }),
	).toBeChecked();
	await dialog.getByRole("button", { name: "Create invitation" }).click();

	const created = page.getByRole("dialog", { name: "Invitation created" });
	await expect(created).toContainText(email);
	const field = created.getByRole("textbox", { name: "Invitation link" });
	await expect(field).toHaveValue(/\/invitation\?id=/);
	await expect(
		created.getByRole("button", { name: "Copy Invitation link" }),
	).toBeVisible();
	const link = await field.inputValue();
	await created.getByRole("button", { name: "Done" }).click();
	await expect(created).toBeHidden();

	// Signing up from the link joins without a verification email.
	const invitee = await browser.newContext();
	const inviteePage = await invitee.newPage();
	await inviteePage.goto(link);
	await expect(
		inviteePage.getByRole("heading", { name: "Join Panara Cloud" }),
	).toBeVisible();
	await fillSignUp(
		inviteePage,
		{ name: "E2E UI Invitee", email },
		{ verified: true, submit: "Create account and join" },
	);
	await inviteePage.getByRole("button", { name: "Accept invitation" }).click();
	await expect(
		inviteePage.getByRole("heading", { name: /^You joined / }),
	).toBeVisible();
	await page.reload();
	await expect(memberRow(page, email)).toContainText("Active");

	await confirmRowAction(page, email, "Delete account");
	await expect(memberRow(page, email)).toHaveCount(0);
	await invitee.close();
	await admin.close();
});
