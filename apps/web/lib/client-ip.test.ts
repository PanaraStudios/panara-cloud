import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp, clientIpProof } from "./client-ip.ts";

test("the client is the last X-Forwarded-For entry, the one our proxy added", () => {
	assert.equal(
		clientIp(new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.4" })),
		"203.0.113.4",
	);
	assert.equal(
		clientIp(new Headers({ "x-real-ip": "203.0.113.5" })),
		"203.0.113.5",
	);
	assert.equal(clientIp(new Headers()), "");
});

test("the address goes to Convex only with the proxy secret", () => {
	const headers = new Headers({ "x-forwarded-for": "203.0.113.4" });
	assert.deepEqual(clientIpProof(headers, "s3cret"), {
		"x-panara-cloud-proxy-secret": "s3cret",
		"x-panara-cloud-client-ip": "203.0.113.4",
	});
	assert.deepEqual(clientIpProof(headers, undefined), {});
	assert.deepEqual(clientIpProof(new Headers(), "s3cret"), {});
});
