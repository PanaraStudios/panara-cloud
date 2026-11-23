import assert from "node:assert/strict";
import { test } from "node:test";
import { maskToken } from "./cluster.ts";

const DIGEST = "5k2q9v4m1p8z3t6w5y0abcdefghij1234567890klmnopqrstu";
const SECRET = "8x7w6v5u4t3s2r1q0p9o8n7m6";
const command = `docker swarm join --token SWMTKN-1-${DIGEST}-${SECRET} 49.12.201.98:2377`;

test("a masked join command shows neither the secret nor the digest", () => {
	const masked = maskToken(command);
	assert.equal(
		masked,
		`docker swarm join --token SWMTKN-1-5k2q${"•".repeat(24)} 49.12.201.98:2377`,
	);
	assert.ok(!masked.includes(SECRET));
	assert.ok(!masked.includes(SECRET.slice(-4)));
	assert.ok(!masked.includes(DIGEST.slice(4)));
});

test("the worker and the manager command mask to the same text", () => {
	const manager = command.replace(SECRET, "1a2b3c4d5e6f7g8h9i0j1k2l3");
	assert.equal(maskToken(manager), maskToken(command));
});

test("text without a token is left alone", () => {
	const install =
		"curl -fsSL https://get.docker.com | sh -s -- --version 28.5.1";
	assert.equal(maskToken(install), install);
});
