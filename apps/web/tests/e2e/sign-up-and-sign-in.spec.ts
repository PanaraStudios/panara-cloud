import { expect, test } from "@playwright/test";
import {
	alert,
	BASE_URL,
	createAccount,
	emailCount,
	fillSignUp,
	invite,
	NO_TEAM_HEADING,
	openVerificationLink,
	PASSWORD,
	signIn,
	signOut,
	uniqueEmail,
	waitForEmail,
} from "./helpers";

test("signed-out visitors are sent to sign in", async ({ page }) => {
	await page.goto("/");
	await expect(page).toHaveURL(/\/login$/);
	await page.goto("/account/security");
	await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fsecurity$/);
	await expect(
		page.getByRole("heading", { name: "Sign in", exact: true }),
	).toBeVisible();
	await page.goto("/settings/members");
	await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fmembers$/);
});

test("an invited user signs up, verifies the email, signs out and back in", async ({
	page,
}) => {
	await page.goto("/signup");
	await expect(page.getByText("invitation-only")).toBeVisible();
	const account = await createAccount(page, "signup");
	await expect(
		page.getByRole("button", { name: "Account menu" }),
	).toContainText(account.email);

	await signOut(page);
	await expect(page.getByText("You've been signed out.")).toBeVisible();

	await signIn(page, account.email, "not the right password", "/account");
	await expect(alert(page)).toContainText(
		"The email or password is incorrect.",
	);

	await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/account\/profile$/);
	await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

	await page.goto("/login");
	await expect(page).toHaveURL(/\/$/);
});

test("signing in before verifying offers a new verification email", async ({
	page,
}) => {
	const email = uniqueEmail("unverified");
	await invite(email);
	await page.goto("/signup");
	await fillSignUp(page, { name: "E2E Unverified", email });
	await expect(
		page.getByText(`We sent a verification link to ${email}`),
	).toBeVisible();
	await waitForEmail(email, "verify");

	await signIn(page, email);
	const notice = alert(page);
	await expect(notice).toContainText("isn't verified yet");
	await waitForEmail(email, "verify", 1);

	await notice.getByRole("link", { name: "Resend verification email" }).click();
	await expect(page).toHaveURL(/\/verify-email\?email=/);
	await expect(page.getByLabel("Email")).toHaveValue(email);
	const before = emailCount(email, "verify");
	await page.getByRole("button", { name: "Send verification email" }).click();
	await expect(page.getByRole("status")).toContainText(email);

	await openVerificationLink(page, await waitForEmail(email, "verify", before));
	await expect(
		page.getByRole("heading", { name: NO_TEAM_HEADING }),
	).toBeVisible();
});

test("sign-up without an invitation is refused with an explanation", async ({
	page,
}) => {
	await page.goto("/signup");
	await page.getByLabel("Name").fill("Uninvited");
	await page.getByLabel("Email").fill(uniqueEmail("uninvited"));
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(alert(page)).toContainText("has no pending invitation");
});

test("a setup link doesn't open sign-up once the instance has an admin", async ({
	page,
	request,
}) => {
	// The first-account form needs the installer's setup link; this instance
	// already has its admin, so a (forged) setup token changes nothing.
	await page.goto("/signup?setup=forged-setup-token");
	await expect(
		page.getByRole("heading", { name: "Create your account" }),
	).toBeVisible();
	await expect(page.getByText("Setup link · first account")).toHaveCount(0);
	const email = uniqueEmail("setup-link");
	await page.getByLabel("Name").fill("Not the admin");
	await page.getByLabel("Email").fill(email);
	await page.getByLabel("Password").fill(PASSWORD);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(alert(page)).toContainText("has no pending invitation");

	const response = await request.post("/api/auth/sign-up/email", {
		data: {
			name: "Not the admin",
			email,
			password: PASSWORD,
			setupToken: "forged-setup-token",
		},
		headers: { Origin: BASE_URL },
	});
	expect(response.ok()).toBe(false);
});

test("a short password is rejected before sign-up", async ({ page }) => {
	await page.goto("/signup");
	await page.getByLabel("Name").fill("Short");
	await page.getByLabel("Email").fill(uniqueEmail("short"));
	const password = page.getByLabel("Password");
	await password.fill("too-short");
	await page.getByRole("button", { name: "Create account" }).click();
	expect(
		await password.evaluate(
			(input: HTMLInputElement) => input.validity.tooShort,
		),
	).toBe(true);
});

test("a broken verification link lands on a page that explains it", async ({
	page,
}) => {
	await page.goto("/api/auth/verify-email?token=not-a-token&callbackURL=%2F");
	await expect(page).toHaveURL(/\/verify-email\?error=INVALID_TOKEN/);
	await expect(
		page.getByRole("heading", { name: "This link isn't valid" }),
	).toBeVisible();
});

test("repeated wrong passwords for one account hit a cooldown", async ({
	page,
	request,
}) => {
	const email = uniqueEmail("brute");
	for (let attempt = 0; attempt < 10; attempt++) {
		const response = await request.post("/api/auth/sign-in/email", {
			data: { email, password: "wrong password attempt" },
			headers: { Origin: BASE_URL },
		});
		expect(response.status()).toBe(401);
	}
	await page.goto("/login");
	await page.getByLabel("Email").fill(email);
	await page
		.getByLabel("Password", { exact: true })
		.fill("wrong password attempt");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(alert(page)).toContainText("Too many attempts");
});
