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
	assert.equal(
		deniedResource({ data: "You don't have access to this server" }),
		"server",
	);
});

test("a refusal that names a permission or a role is a page the member can't open", () => {
	for (const message of [
		"Requires the server.read permission",
		"Requires the admin role",
		"Requires an instance administrator",
		"Not a member of this organization",
		"Only the instance administrator can manage the Panara Cloud server",
	]) {
		assert.equal(deniedResource({ data: message }), "page", message);
		assert.equal(
			deniedResource(
				new Error(`[CONVEX Q(servers:get)] Uncaught ConvexError: ${message}`),
			),
			"page",
			message,
		);
	}
});

test("other failures are not access refusals", () => {
	assert.equal(deniedResource(new Error("Network error")), null);
	assert.equal(deniedResource({ data: "Server is inactive" }), null);
	assert.equal(deniedResource({ data: "Requires a registry" }), null);
	assert.equal(deniedResource({ data: { code: "x" } }), null);
	assert.equal(deniedResource(null), null);
});
