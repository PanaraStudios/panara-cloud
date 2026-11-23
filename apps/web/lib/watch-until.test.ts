import assert from "node:assert/strict";
import { test } from "node:test";
import { watchUntil } from "./watch-until.ts";

// A subscription whose value the test sets; `push` is what Convex does when
// the query's result changes.
const subscription = (initial?: unknown) => {
	let value = initial;
	let listeners: (() => void)[] = [];
	let fail: Error | null = null;
	return {
		watch: {
			localQueryResult: () => {
				if (fail) throw fail;
				return value;
			},
			onUpdate: (callback: () => void) => {
				listeners.push(callback);
				return () => {
					listeners = listeners.filter((item) => item !== callback);
				};
			},
		},
		push: (next: unknown) => {
			value = next;
			for (const listener of [...listeners]) listener();
		},
		break: (error: Error) => {
			fail = error;
			for (const listener of [...listeners]) listener();
		},
		listening: () => listeners.length,
	};
};

type Op = { status: string; error?: string };
const finished = (op: Op) => {
	if (op.status === "running") return undefined;
	if (op.status !== "succeeded") throw new Error(op.error ?? op.status);
	return "done";
};

test("resolves once the value settles, and stops listening", async () => {
	const s = subscription();
	const waiting = watchUntil<Op, string>(s.watch, finished);
	s.push({ status: "running" });
	assert.equal(s.listening(), 1);
	s.push({ status: "succeeded" });
	assert.equal(await waiting, "done");
	assert.equal(s.listening(), 0);
});

test("a job that fails while it is waited for rejects, instead of throwing into the subscription", async () => {
	const s = subscription({ status: "running" });
	const waiting = watchUntil<Op, string>(s.watch, finished);
	// The update must not throw: Convex calls it, and nobody catches there.
	assert.doesNotThrow(() =>
		s.push({ status: "failed", error: "The agent doesn't know the panel" }),
	);
	await assert.rejects(waiting, /The agent doesn't know the panel/);
	assert.equal(s.listening(), 0);
	// Later updates are ignored.
	assert.doesNotThrow(() => s.push({ status: "failed", error: "again" }));
});

test("a job that had already failed rejects at once", async () => {
	const s = subscription({ status: "failed", error: "no such container" });
	await assert.rejects(
		watchUntil<Op, string>(s.watch, finished),
		/no such container/,
	);
	assert.equal(s.listening(), 0);
});

test("a query that fails rejects", async () => {
	const s = subscription();
	const waiting = watchUntil<Op, string>(s.watch, finished);
	assert.doesNotThrow(() => s.break(new Error("You don't have access")));
	await assert.rejects(waiting, /You don't have access/);
	assert.equal(s.listening(), 0);
});
