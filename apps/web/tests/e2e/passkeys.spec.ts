import { expect, test } from "@playwright/test";
import {
	addVirtualAuthenticator,
	createAccount,
	expectHome,
	signOut,
} from "./helpers";

test("passkeys: add, sign in without a password, rename, delete", async ({
	context,
	page,
}) => {
	await addVirtualAuthenticator(context, page);
	await createAccount(page, "passkey");

	await page.goto("/account/security");
	await expect(
		page.getByText("You haven't added any passkeys yet."),
	).toBeVisible();
	await page.getByRole("button", { name: "Add a passkey" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Passkey name").fill("Test key");
	await dialog.getByRole("button", { name: "Create passkey" }).click();
	await expect(dialog).toBeHidden();
	const passkeys = page.getByRole("list", { name: "Your passkeys" });
	const passkey = (name: string) =>
		passkeys.getByRole("listitem").filter({ hasText: name });
	await expect(passkey("Test key")).toBeVisible();

	await signOut(page);
	await page.getByRole("button", { name: "Sign in with a passkey" }).click();
	await expectHome(page);

	await page.goto("/account/security");
	await passkey("Test key").getByRole("button", { name: "Rename" }).click();
	await expect(dialog.getByLabel("Passkey name")).toHaveValue("Test key");
	await dialog.getByLabel("Passkey name").fill("Work laptop");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
	await expect(passkey("Work laptop")).toBeVisible();
	await expect(passkey("Test key")).toHaveCount(0);

	await passkey("Work laptop").getByRole("button", { name: "Delete" }).click();
	await expect(dialog).toContainText("Work laptop");
	await dialog.getByRole("button", { name: "Delete passkey" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("You haven't added any passkeys yet."),
	).toBeVisible();
});
