import assert from "node:assert/strict";
import { test } from "node:test";
import { deniedResource } from "./access-denied.ts";

test("recognises the backend's permission refusals", () => {
	assert.equal(
		deniedResource({ data: "You don't have access to this service" }),
		"service",
	);
	assert.equal(
		deniedResource(
			new Error(
				"[CONVEX Q(applications:get)] Uncaught ConvexError: You don't have access to this project",
			),
		),
		"project",
	);
	assert.equal(
		deniedResource({ data: "You don't have access to this environment" }),
		"environment",
	);
});

test("other failures are not access refusals", () => {
	assert.equal(deniedResource(new Error("Network error")), null);
	assert.equal(deniedResource({ data: { code: "x" } }), null);
	assert.equal(deniedResource(null), null);
});
