import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNext } from "./next-path.ts";

test("keeps same-origin paths", () => {
	assert.equal(safeNext("/projects"), "/projects");
	assert.equal(safeNext("/a/b?x=1#top"), "/a/b?x=1#top");
	assert.equal(safeNext("/a/../b"), "/b");
});

test("refuses anything that could leave the origin", () => {
	for (const value of [
		null,
		undefined,
		"",
		"projects",
		"https://evil.com",
		"//evil.com",
		"/\\evil.com",
		"/\t/evil.com",
		"/%09/evil.com",
		"/\n/evil.com",
		"/\r/evil.com",
		"/\u0000/evil.com",
		"javascript:alert(1)",
	]) {
		const result = safeNext(value, "/fallback");
		assert.ok(
			result === "/fallback" ||
				(result.startsWith("/") && !result.startsWith("//")),
			`${JSON.stringify(value)} -> ${result}`,
		);
		assert.equal(
			new URL(result, "https://panel.test").origin,
			"https://panel.test",
		);
	}
	assert.equal(safeNext("/\t/evil.com", "/fallback"), "/fallback");
	assert.equal(safeNext("//evil.com", "/fallback"), "/fallback");
});
