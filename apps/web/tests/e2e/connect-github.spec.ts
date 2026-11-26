import { expect, type Page, test } from "@playwright/test";
import { adminContext } from "./helpers";

// Creating the GitHub App posts its manifest from the panel to GitHub, so
// the page's Content-Security-Policy must allow that form target. GitHub is
// stubbed: the test only checks the post leaves the panel.
async function createApp(page: Page, owner: "personal" | "org") {
	await page.route("https://github.com/**", (route) =>
		route.fulfill({ status: 200, contentType: "text/html", body: "stub" }),
	);
	await page.goto("/settings/git/new?provider=github");
	if (owner === "org") {
		await page.getByRole("tab", { name: "Organization" }).click();
		await page.getByLabel("Organization name").fill("acme-e2e");
	}
	const posted = page.waitForRequest(
		(request) =>
			request.method() === "POST" &&
			request.url().startsWith("https://github.com/"),
	);
	await page
		.getByRole("button", { name: "Create GitHub App on GitHub" })
		.click();
	const request = await posted;
	expect(request.postData() ?? "").toContain("manifest=");
	return new URL(request.url());
}

test("the GitHub App manifest is posted to GitHub", async ({ browser }) => {
	const context = await adminContext(browser);
	const page = await context.newPage();
	const url = await createApp(page, "personal");
	expect(url.pathname).toBe("/settings/apps/new");
	expect(url.searchParams.get("state")).toBeTruthy();
	await context.close();
});

test("an organization's GitHub App manifest is posted to that organization", async ({
	browser,
}) => {
	const context = await adminContext(browser);
	const page = await context.newPage();
	const url = await createApp(page, "org");
	expect(url.pathname).toBe("/organizations/acme-e2e/settings/apps/new");
	await context.close();
});
