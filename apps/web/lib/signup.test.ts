import assert from "node:assert/strict";
import { test } from "node:test";
import {
	backendReach,
	signUpBlocker,
	signUpProof,
	unreachableMessage,
} from "./signup.ts";

test("the setup token is sent whenever the link carried one", () => {
	assert.deepEqual(signUpProof({ setupToken: "tok" }), { setupToken: "tok" });
	assert.deepEqual(signUpProof({ setupToken: "tok", invitationId: "inv" }), {
		invitationId: "inv",
		setupToken: "tok",
	});
	assert.deepEqual(signUpProof({ invitationId: "inv" }), {
		invitationId: "inv",
	});
	assert.deepEqual(signUpProof({}), {});
	assert.deepEqual(signUpProof({ setupToken: "" }), {});
});

test("the page is ready only once its sign-up state has loaded", () => {
	const fresh = { loaded: false, hasEverConnected: false, waited: false };
	assert.equal(backendReach(fresh), "loading");
	assert.equal(backendReach({ ...fresh, hasEverConnected: true }), "loading");
	assert.equal(
		backendReach({ ...fresh, hasEverConnected: true, waited: true }),
		"loading",
	);
	assert.equal(backendReach({ ...fresh, waited: true }), "unreachable");
	assert.equal(backendReach({ ...fresh, loaded: true }), "ready");
	assert.equal(
		backendReach({ loaded: true, hasEverConnected: false, waited: true }),
		"ready",
	);
});

test("submitting is blocked, with the reason, until the page is ready", () => {
	assert.equal(signUpBlocker("ready"), null);
	assert.equal(signUpBlocker("loading"), "Loading…");
	assert.equal(
		signUpBlocker("unreachable"),
		"This page can't reach the panel's backend",
	);
});

test("an unreachable backend is named with its address and port", () => {
	const ip = unreachableMessage(
		"http://203.0.113.10:3210",
		"http://203.0.113.10:3000",
	);
	assert.match(ip, /backend at http:\/\/203\.0\.113\.10:3210,/);
	assert.match(ip, /port 3210 is open in the server's firewall/);
	assert.doesNotMatch(ip, /setup link/);

	const custom = unreachableMessage(
		"http://203.0.113.10:4210/",
		"http://203.0.113.10:8080",
	);
	assert.match(custom, /port 4210 is open/);

	const domain = unreachableMessage(
		"https://panel.example.com/convex",
		"https://panel.example.com",
	);
	assert.match(domain, /backend at https:\/\/panel\.example\.com\/convex,/);
	assert.match(domain, /docker service ps panara-cloud-convex/);
	assert.doesNotMatch(domain, /firewall/);

	assert.match(
		unreachableMessage("", "http://x"),
		/can't reach the panel's backend/,
	);
});
