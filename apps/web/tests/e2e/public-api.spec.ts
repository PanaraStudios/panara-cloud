import { expect, test } from "@playwright/test";

test("the public API answers on the panel's own origin", async ({
	request,
}) => {
	const missing = await request.get("/api/v1/projects", {
		maxRedirects: 0,
	});
	expect(missing.status()).toBe(401);
	expect(await missing.json()).toMatchObject({
		error: expect.stringMatching(/API key/),
	});

	const invalid = await request.get("/api/v1/me", {
		headers: { "x-api-key": "pnr_not-a-real-key" },
		maxRedirects: 0,
	});
	expect(invalid.status()).toBe(401);
});
