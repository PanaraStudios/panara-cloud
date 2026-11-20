import { expect, type Page, test } from "@playwright/test";
import {
	adminContext,
	alert,
	BASE_URL,
	createAccount,
	emailCount,
	expectHome,
	fillSignUp,
	invite,
	signIn,
	signOut,
	uniqueEmail,
	waitForEmail,
} from "./helpers";

function sessionRows(page: Page) {
	return page.getByRole("table").locator("tbody").getByRole("row");
}

test("sessions: list devices, sign out one, then all others", async ({
	page,
	browser,
}) => {
	const account = await createAccount(page, "sessions");
	const firefox = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
	});
	const iphone = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	});
	const firefoxPage = await firefox.newPage();
	const iphonePage = await iphone.newPage();
	for (const other of [firefoxPage, iphonePage]) {
		await signIn(other, account.email);
		await expectHome(other);
	}

	await page.goto("/account/sessions");
	const rows = sessionRows(page);
	await expect(rows.filter({ hasText: "This device" })).toContainText(
		"Chrome on",
	);
	await expect(rows).toHaveCount(3);
	await expect(rows.filter({ hasText: "Firefox on Linux" })).toHaveCount(1);
	await expect(rows.filter({ hasText: "Safari on iOS" })).toHaveCount(1);
	// The current session can't be signed out from the list.
	await expect(
		rows
			.filter({ hasText: "This device" })
			.getByRole("button", { name: /^Sign out/ }),
	).toHaveCount(0);

	await page
		.getByRole("button", { name: "Sign out Firefox on Linux session" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Signed out Firefox on Linux.",
	);
	await expect(rows).toHaveCount(2);
	await firefoxPage.goto("/account/profile");
	await expect(firefoxPage).toHaveURL(/\/login\?next=%2Faccount%2Fprofile/);

	await page
		.getByRole("button", { name: "Sign out all other sessions" })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"Signed out of all other sessions.",
	);
	await expect(rows).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "Sign out all other sessions" }),
	).toHaveCount(0);
	await iphonePage.goto("/account/profile");
	await expect(iphonePage).toHaveURL(/\/login\?next=%2Faccount%2Fprofile/);

	await page.reload();
	await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
	await expect(rows.filter({ hasText: "This device" })).toHaveCount(1);
	await firefox.close();
	await iphone.close();
});

test("a new user signs up and accepts an invitation on its link's page", async ({
	page,
}) => {
	const email = uniqueEmail("invitee");
	const { invitationId, organizationName } = await invite(email, "admin");
	const link = await waitForEmail(email, "invite");
	expect(link).toContain(`/invitation?id=${invitationId}`);

	await page.goto(link);
	await expect(page.getByText("You've been invited to")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Join Panara Cloud" }),
	).toBeVisible();
	await fillSignUp(
		page,
		{ name: "E2E Invitee", email },
		{ verified: true, submit: "Create account and join" },
	);

	// The invitation link proves the address: no verification email, the
	// new account is signed in and stays on the invitation.
	await expect(page).toHaveURL(new RegExp(`/invitation\\?id=${invitationId}`));
	await expect(
		page.getByRole("heading", { name: `Join ${organizationName}` }),
	).toBeVisible();
	expect(emailCount(email, "verify")).toBe(0);
	await expect(page.getByText(email, { exact: true })).toBeVisible();
	await expect(page.getByText("Admin", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Accept invitation" }).click();
	await expect(
		page.getByRole("heading", { name: `You joined ${organizationName}` }),
	).toBeVisible();
	await page.getByRole("link", { name: "Continue to Panara Cloud" }).click();
	await expectHome(page);

	await page.goto(link);
	await expect(page.getByText("was already accepted")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Accept invitation" }),
	).toHaveCount(0);
});

test("an invitation link can't be used to sign up with another address", async ({
	page,
}) => {
	const email = uniqueEmail("invited-address");
	const { invitationId } = await invite(email);
	await page.goto(`/invitation?id=${invitationId}`);
	await fillSignUp(
		page,
		{ name: "E2E Interloper", email: uniqueEmail("interloper") },
		{ verified: true, submit: "Create account and join" },
	);
	await expect(alert(page)).toBeVisible();
	// Still signed out, on the sign-up form.
	await expect(
		page.getByRole("heading", { name: "Join Panara Cloud" }),
	).toBeVisible();
	const session = await page.request.get("/api/auth/get-session");
	expect(await session.text()).toMatch(/^(null)?$/);
});

test("an existing user signs in from an invitation link and declines it", async ({
	page,
}) => {
	const account = await createAccount(page, "decliner", { join: false });
	const { invitationId, organizationName } = account;
	await signOut(page);

	await page.goto(`/invitation?id=${invitationId}`);
	await page
		.getByRole("navigation", { name: "Account options" })
		.getByRole("link", { name: "Sign in" })
		.click();
	await expect(page).toHaveURL(/\/login\?next=%2Finvitation/);
	await page.getByLabel("Email").fill(account.email);
	await page.getByLabel("Password", { exact: true }).fill(account.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: `Join ${organizationName}` }),
	).toBeVisible();
	await page.getByRole("button", { name: "Decline" }).click();
	await expect(
		page.getByRole("heading", { name: "Invitation declined" }),
	).toBeVisible();
});

test("an invitation for another address can't be accepted", async ({
	page,
}) => {
	await createAccount(page, "wrong-account");
	const { invitationId } = await invite(uniqueEmail("someone-else"));
	await page.goto(`/invitation?id=${invitationId}`);
	await expect(page.getByText(/signed in as/i).first()).toBeVisible();
	const accept = page.getByRole("button", { name: "Accept invitation" });
	if ((await accept.count()) > 0) {
		await expect(accept).toBeDisabled();
		await expect(page.getByText("Signed in with another email")).toBeVisible();
	} else {
		await expect(
			page.getByRole("heading", { name: "Invitation unavailable" }),
		).toBeVisible();
	}
	const response = await page.request.post(
		"/api/auth/organization/accept-invitation",
		{ data: { invitationId }, headers: { Origin: BASE_URL } },
	);
	expect(response.ok()).toBe(false);
});

test("members join organizations but cannot create their own or manage members", async ({
	page,
	browser,
}) => {
	await createAccount(page, "no-orgs");
	// With a single organization the switcher is hidden; the account menu
	// offers "Add organization" to the instance admin only.
	await expect(
		page.getByRole("button", { name: /^Organization:/ }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Account menu" }).click();
	await expect(page.getByRole("menuitem", { name: "Log out" })).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Add organization" }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	const response = await page.request.post("/api/auth/organization/create", {
		data: { name: "Mine", slug: `mine-${Date.now()}` },
		headers: { Origin: BASE_URL },
	});
	expect(response.ok()).toBe(false);

	// Settings sections a member may not use redirect away.
	for (const section of ["/settings/members", "/settings/email"]) {
		await page.goto(section);
		await expect(page).not.toHaveURL(new RegExp(`${section}$`));
	}

	// The admin's account menu does offer it (one organization) or the
	// switcher does (several).
	const admin = await adminContext(browser);
	const adminPage = await admin.newPage();
	await adminPage.goto("/");
	await expectHome(adminPage);
	const switcher = adminPage.getByRole("button", { name: /^Organization:/ });
	if ((await switcher.count()) === 0) {
		await adminPage.getByRole("button", { name: "Account menu" }).click();
		await expect(
			adminPage.getByRole("menuitem", { name: "Add organization" }),
		).toBeVisible();
	}
	await admin.close();
});
