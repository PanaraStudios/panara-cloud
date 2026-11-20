import { expect, type Page, test } from "@playwright/test";
import {
	alert,
	createAccount,
	expectHome,
	freshTotp,
	PASSWORD,
	signIn,
	signOut,
} from "./helpers";

async function readBackupCodes(page: Page) {
	const list = page.getByRole("list", { name: "Backup codes" });
	await expect(list).toBeVisible();
	return (await list.getByRole("listitem").allTextContents()).map((code) =>
		code.trim(),
	);
}

async function codeStep(page: Page) {
	await expect(page).toHaveURL(/\/mfa/);
	await expect(
		page.getByRole("heading", { name: "Two-factor authentication" }),
	).toBeVisible();
}

// The sign-in code is six digit boxes over one input.
async function enterTotp(page: Page, code: string) {
	const verify = page.getByRole("button", { name: "Verify", exact: true });
	await expect(verify).toBeDisabled();
	await page.getByLabel("Authentication code").fill(code);
	await expect(verify).toBeEnabled();
	await verify.click();
}

async function enterBackupCode(page: Page, code: string) {
	await page.getByLabel("Backup code").fill(code);
	await page.getByRole("button", { name: "Verify", exact: true }).click();
}

async function turnOn(page: Page, { wrongFirst = false } = {}) {
	await page.goto("/account/security");
	await page.getByRole("button", { name: "Turn on", exact: true }).click();
	const dialog = page.getByRole("dialog");
	if (wrongFirst) {
		await dialog.getByLabel("Password").fill("wrong password value");
		await dialog.getByRole("button", { name: "Continue" }).click();
		await expect(dialog.getByRole("alert")).toContainText(
			"The password is incorrect.",
		);
	}
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Continue" }).click();

	await expect(
		dialog.getByRole("img", { name: "QR code for your authenticator app" }),
	).toBeVisible();
	// Shown in groups of four for reading aloud.
	const secret = (
		(await dialog.getByTestId("totp-secret").textContent()) ?? ""
	).replace(/\s+/g, "");
	expect(secret).toMatch(/^[A-Z2-7]+=*$/);
	const code = dialog.getByLabel("6-digit code from the app");
	if (wrongFirst) {
		await code.fill("000000");
		await dialog.getByRole("button", { name: "Verify and turn on" }).click();
		await expect(dialog.getByRole("alert")).toContainText(
			"That code is incorrect",
		);
	}
	await code.fill(await freshTotp(secret));
	await dialog.getByRole("button", { name: "Verify and turn on" }).click();

	await expect(
		dialog.getByRole("heading", { name: "Save your backup codes" }),
	).toBeVisible();
	const codes = await readBackupCodes(page);
	await expect(dialog.getByRole("button", { name: "Download" })).toBeVisible();
	await dialog.getByRole("button", { name: "I've saved my codes" }).click();
	await expect(dialog).toBeHidden();
	return { secret, codes };
}

test("two-factor: enable, sign in with TOTP and backup codes, regenerate, disable", async ({
	page,
}) => {
	const account = await createAccount(page, "totp");
	const { secret, codes } = await turnOn(page, { wrongFirst: true });
	expect(codes.length).toBeGreaterThanOrEqual(4);
	const status = page
		.getByRole("heading", { name: /^Two-factor authentication/ })
		.getByText("On", { exact: true });
	await expect(status).toBeVisible();

	await signOut(page);
	await signIn(page, account.email);
	await codeStep(page);
	await enterTotp(page, "000000");
	await expect(alert(page)).toContainText("incorrect");
	await page.getByLabel("Authentication code").clear();
	await enterTotp(page, await freshTotp(secret));
	await expectHome(page);

	await signOut(page);
	await signIn(page, account.email);
	await codeStep(page);
	await page.getByRole("button", { name: "Use a backup code" }).click();
	await enterBackupCode(page, codes[0] ?? "");
	await expectHome(page);

	await signOut(page);
	await signIn(page, account.email);
	await codeStep(page);
	await page.getByRole("button", { name: "Use a backup code" }).click();
	await enterBackupCode(page, codes[0] ?? "");
	await expect(alert(page)).toContainText(
		"That backup code is incorrect or has already been used.",
	);
	await enterBackupCode(page, codes[1] ?? "");
	await expectHome(page);

	await page.goto("/account/security");
	await page.getByRole("button", { name: "Regenerate backup codes" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Regenerate codes" }).click();
	const regenerated = await readBackupCodes(page);
	expect(regenerated).not.toContain(codes[2]);
	await dialog.getByRole("button", { name: "I've saved my codes" }).click();
	await expect(dialog).toBeHidden();

	await signOut(page);
	await signIn(page, account.email);
	await codeStep(page);
	await page.getByRole("button", { name: "Use a backup code" }).click();
	await enterBackupCode(page, codes[2] ?? "");
	await expect(alert(page)).toContainText("That backup code is incorrect");
	await enterBackupCode(page, regenerated[0] ?? "");
	await expectHome(page);

	await page.goto("/account/security");
	await page.getByRole("button", { name: "Turn off", exact: true }).click();
	await dialog.getByLabel("Password").fill(PASSWORD);
	await dialog.getByRole("button", { name: "Turn off", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Two-factor authentication is off."),
	).toBeVisible();
	await expect(
		page
			.getByRole("heading", { name: /^Two-factor authentication/ })
			.getByText("Off", { exact: true }),
	).toBeVisible();

	await signOut(page);
	await signIn(page, account.email);
	await expectHome(page);
});

test("trusting a device skips the code on the next sign-in", async ({
	page,
}) => {
	const account = await createAccount(page, "trust");
	const { secret } = await turnOn(page);

	await signOut(page);
	await signIn(page, account.email);
	await codeStep(page);
	await page
		.getByRole("checkbox", { name: "Trust this device for 30 days" })
		.click();
	await enterTotp(page, await freshTotp(secret));
	await expectHome(page);

	await signOut(page);
	await signIn(page, account.email);
	await expectHome(page);
});
