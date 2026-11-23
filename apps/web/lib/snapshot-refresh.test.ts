import assert from "node:assert/strict";
import { test } from "node:test";
import {
	liveSessionUsable,
	snapshotRefreshing,
	snapshotSessionRequest,
} from "./snapshot-refresh.ts";

test("a polled Docker listing opens a live session instead of queuing jobs", () => {
	assert.deepEqual(
		snapshotSessionRequest({
			enabled: true,
			serverId: "srv1",
			kind: "containers",
			refreshInterval: 10_000,
		}),
		{
			kind: "hostSnapshot",
			serverId: "srv1",
			what: "containers",
			intervalMs: 10_000,
		},
	);
	assert.equal(
		snapshotSessionRequest({
			enabled: true,
			serverId: undefined,
			kind: "swarmNodes",
			refreshInterval: 5000,
		})?.what,
		"swarmNodes",
	);
});

test("a snapshot read once, a disabled one or one needing a job opens none", () => {
	const base = { enabled: true, serverId: "srv1", refreshInterval: 10_000 };
	assert.equal(
		snapshotSessionRequest({
			...base,
			kind: "containers",
			refreshInterval: undefined,
		}),
		null,
	);
	assert.equal(
		snapshotSessionRequest({ ...base, kind: "containers", enabled: false }),
		null,
	);
	assert.equal(snapshotSessionRequest({ ...base, kind: "audit" }), null);
	assert.equal(snapshotSessionRequest({ ...base, kind: "traefik" }), null);
});

test("the page falls back to refresh jobs only once the session is gone", () => {
	const request = { kind: "hostSnapshot" };
	for (const status of ["idle", "connecting", "open"] as const) {
		assert.equal(liveSessionUsable(request, status), true, status);
	}
	for (const status of ["error", "closed"] as const) {
		assert.equal(liveSessionUsable(request, status), false, status);
	}
	assert.equal(liveSessionUsable(null, "open"), false);
});

test("a live session that does not open in time is not waited for", () => {
	const request = { kind: "hostSnapshot" };
	// The socket is still being retried (the live port is closed, say): the
	// page reads through refresh jobs meanwhile instead of showing a skeleton.
	for (const status of ["idle", "connecting"] as const) {
		assert.equal(liveSessionUsable(request, status, true), false, status);
	}
	// Once it does open it takes over again, whatever was waited before.
	assert.equal(liveSessionUsable(request, "open", true), true);
	assert.equal(liveSessionUsable(request, "error", true), false);
});

test("refreshing covers jobs, Refresh presses and a live session's first reading", () => {
	const idle = {
		pendingJobId: null,
		refreshPressed: false,
		live: false,
		liveRead: false,
	};
	assert.equal(snapshotRefreshing(idle), false);
	assert.equal(snapshotRefreshing({ ...idle, pendingJobId: "j1" }), true);
	assert.equal(snapshotRefreshing({ ...idle, refreshPressed: true }), true);
	assert.equal(snapshotRefreshing({ ...idle, live: true }), true);
	assert.equal(
		snapshotRefreshing({ ...idle, live: true, liveRead: true }),
		false,
	);
});
