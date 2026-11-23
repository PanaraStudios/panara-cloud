import assert from "node:assert/strict";
import { test } from "node:test";
import { linkErrorRedirect } from "./link-errors.ts";

const at = (path: string) => {
	const url = new URL(path, "http://panel.test");
	return linkErrorRedirect(url.pathname, url.searchParams);
};

test("an expired email link goes to the page that explains it", () => {
	assert.equal(
		at("/?error=TOKEN_EXPIRED"),
		"/verify-email?error=TOKEN_EXPIRED",
	);
	assert.equal(
		at("/settings?error=INVALID_TOKEN&tab=a"),
		"/verify-email?error=INVALID_TOKEN&next=%2Fsettings%3Ftab%3Da",
	);
});

test("other errors and the auth pages themselves are left alone", () => {
	assert.equal(at("/?error=SOMETHING_ELSE"), null);
	assert.equal(at("/settings/git?error=access_denied"), null);
	assert.equal(at("/login?error=TOKEN_EXPIRED"), null);
	assert.equal(at("/reset-password?error=INVALID_TOKEN"), null);
	assert.equal(at("/projects"), null);
});
