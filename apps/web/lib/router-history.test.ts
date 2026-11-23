import assert from "node:assert/strict";
import { test } from "node:test";
import { followHistoryCalls } from "./router-history.ts";

const fakeHistory = () => {
	const calls: string[] = [];
	const history = {
		pushState: (_data: unknown, _unused: string, url?: string | URL | null) => {
			calls.push(`push ${url ?? ""}`);
		},
		replaceState: (
			_data: unknown,
			_unused: string,
			url?: string | URL | null,
		) => {
			calls.push(`replace ${url ?? ""}`);
		},
	};
	return { history, calls };
};

test("app calls that change the URL reach the router", () => {
	const { history, calls } = fakeHistory();
	let seen = 0;
	followHistoryCalls(history, () => seen++);

	history.pushState(null, "", "/servers/s1/settings/security");
	history.replaceState(null, "", "/servers/s1/settings/gpu");

	assert.deepEqual(calls, [
		"push /servers/s1/settings/security",
		"replace /servers/s1/settings/gpu",
	]);
	assert.equal(seen, 2);
});

test("state-only calls and the router's own calls are not reported", () => {
	const { history, calls } = fakeHistory();
	let seen = 0;
	const raw = followHistoryCalls(history, () => seen++);

	history.replaceState({ scrollY: 10 }, "");
	raw.push(null, "", "/projects");
	raw.replace(null, "", "/projects?tab=1");

	assert.deepEqual(calls, [
		"replace ",
		"push /projects",
		"replace /projects?tab=1",
	]);
	assert.equal(seen, 0);
});
