import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesText, parseLogText } from "./log-entries.ts";
import { displayOrder, waitingCount } from "./viewer-order.ts";

const shown = (count: number, dividers: number[] = []) => {
	const order = displayOrder(count, "newest", dividers);
	return Array.from({ length: count }, (_, index) => order.toChrono(index));
};

test("oldest first is the order rows are kept in", () => {
	const order = displayOrder(4, "oldest", [1]);
	assert.deepEqual([0, 1, 2, 3].map(order.toChrono), [0, 1, 2, 3]);
	assert.deepEqual([0, 1, 2, 3].map(order.toDisplay), [0, 1, 2, 3]);
});

test("newest first turns the rows over", () => {
	assert.deepEqual(shown(4), [3, 2, 1, 0]);
	assert.deepEqual(shown(0), []);
	const order = displayOrder(4, "newest");
	assert.equal(order.toDisplay(3), 0);
	assert.equal(order.toDisplay(0), 3);
});

test("newest first keeps a section's title above its lines", () => {
	// 0 1 are printed before any step; 2 and 5 are step titles.
	assert.deepEqual(shown(8, [2, 5]), [5, 7, 6, 2, 4, 3, 1, 0]);
	// A title with nothing under it yet (the step just started) is the top row.
	assert.deepEqual(shown(4, [1, 3]), [3, 1, 2, 0]);
	assert.deepEqual(shown(3, [0]), [0, 2, 1]);
});

test("a row's place in the list and the row at that place agree", () => {
	for (const [count, dividers] of [
		[8, [2, 5]],
		[9, [0, 1, 8]],
		[5, []],
		[1, [0]],
	] as const) {
		const order = displayOrder(count, "newest", dividers);
		for (let chrono = 0; chrono < count; chrono++) {
			assert.equal(order.toChrono(order.toDisplay(chrono)), chrono);
		}
	}
});

test("only entries are turned over: a stack trace reads top to bottom, and a copy is oldest first", () => {
	const text = [
		"## Build",
		"INFO compiling",
		"ERROR build failed",
		"    at compile (/app/build.js:4:2)",
		"    at main (/app/build.js:9:1)",
		"## Deploy",
		"INFO started",
	].join("\n");
	const entries = parseLogText(text);
	const order = displayOrder(
		entries.length,
		"newest",
		entries.flatMap((entry, index) =>
			entry.kind === "section" ? [index] : [],
		),
	);
	const list = entries.map((_, index) => entries[order.toChrono(index)]);
	assert.deepEqual(
		list.map((entry) => entry?.message),
		["Deploy", "started", "Build", "build failed", "compiling"],
	);
	assert.deepEqual(list[3]?.attached, [
		"    at compile (/app/build.js:4:2)",
		"    at main (/app/build.js:9:1)",
	]);
	// What is copied or downloaded comes from the rows as kept, whatever the
	// list shows first.
	assert.equal(entriesText(entries), text);
});

test("rows waiting behind a paused tail are counted in a few characters", () => {
	assert.deepEqual(waitingCount(9), { text: "9", badge: "9" });
	assert.deepEqual(waitingCount(99), { text: "99", badge: "99" });
	assert.deepEqual(waitingCount(100), { text: "100", badge: "99+" });
	assert.deepEqual(waitingCount(9_999), { text: "9,999", badge: "99+" });
	assert.deepEqual(waitingCount(10_000), { text: "10.0k", badge: "99+" });
	assert.deepEqual(waitingCount(48_260), { text: "48.3k", badge: "99+" });
});
