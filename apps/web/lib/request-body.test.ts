import assert from "node:assert/strict";
import { test } from "node:test";
import { hasApiKey, readCappedBody } from "./request-body.ts";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
	new Request("http://panel.test/api/v1/call/x", {
		method: "POST",
		body,
		headers,
		duplex: "half",
	} as RequestInit);

test("a body within the limit is read whole", async () => {
	const body = await readCappedBody(post("hello"), 10);
	assert.equal(new TextDecoder().decode(body ?? undefined), "hello");
});

test("a larger body is refused, declared or streamed", async () => {
	assert.equal(
		await readCappedBody(post("x".repeat(11), { "content-length": "11" }), 10),
		null,
	);
	const stream = new ReadableStream({
		start(controller) {
			for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(4));
			controller.close();
		},
	});
	assert.equal(await readCappedBody(post(stream), 10), null);
});

test("a key is a non-empty x-api-key or a Bearer token", () => {
	assert.equal(hasApiKey(new Headers({ "x-api-key": "pnr_x" })), true);
	assert.equal(hasApiKey(new Headers({ authorization: "Bearer pnr_x" })), true);
	assert.equal(hasApiKey(new Headers({ authorization: "Basic abc" })), false);
	assert.equal(hasApiKey(new Headers({ cookie: "session=1" })), false);
});
