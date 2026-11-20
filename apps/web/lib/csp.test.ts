import assert from "node:assert/strict";
import { test } from "node:test";
import { contentSecurityPolicy } from "./csp.ts";

const directive = (policy: string, name: string) =>
	policy
		.split("; ")
		.find((d) => d.startsWith(`${name} `))
		?.split(" ")
		.slice(1);

test("a domain install allows its own HTTPS origin for Convex and live", () => {
	const policy = contentSecurityPolicy({
		convexUrl: "https://panel.example.com/convex",
		liveUrl: "wss://panel.example.com",
	});
	assert.deepEqual(directive(policy, "connect-src"), [
		"'self'",
		"https://panel.example.com",
		"wss://panel.example.com",
	]);
	assert.deepEqual(directive(policy, "frame-ancestors"), ["'none'"]);
	assert.deepEqual(directive(policy, "default-src"), ["'self'"]);
	assert.ok(!policy.includes("unsafe-eval"));
});

test("an IP install allows the Convex and live ports", () => {
	const policy = contentSecurityPolicy({
		convexUrl: "http://203.0.113.5:3210",
		liveUrl: "ws://203.0.113.5:7100",
	});
	assert.deepEqual(directive(policy, "connect-src"), [
		"'self'",
		"http://203.0.113.5:3210",
		"ws://203.0.113.5:3210",
		"http://203.0.113.5:7100",
		"ws://203.0.113.5:7100",
	]);
});

test("without a live URL WebSockets stay allowed", () => {
	const policy = contentSecurityPolicy({ convexUrl: "https://x.test/convex" });
	assert.ok(directive(policy, "connect-src")?.includes("wss:"));
});
