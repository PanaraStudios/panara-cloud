import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLEANUP_ACTIONS,
	cleanupAction,
	NIGHTLY_CLEANUP,
} from "./docker-cleanup.ts";

test("the nightly clean-up says what it removes and whose", () => {
	assert.equal(
		NIGHTLY_CLEANUP,
		"Every night, removes stopped containers, unused images, unused networks and build cache on this server, including ones Panara Cloud did not create.",
	);
	assert.doesNotMatch(NIGHTLY_CLEANUP, /volume/i);
});

test("the one-off clean-up of everything matches the nightly one and keeps volumes", () => {
	const all = cleanupAction("all");
	for (const removed of [
		"stopped containers",
		"unused images",
		"unused networks",
		"build cache",
		"including ones Panara Cloud did not create",
	]) {
		assert.ok(NIGHTLY_CLEANUP.includes(removed), removed);
		assert.ok(all.description.includes(removed), removed);
	}
	assert.match(all.description, /Volumes are kept\./);
	assert.match(all.label, /except volumes/);
});

test("every Docker clean-up says it also takes what Panara Cloud did not create", () => {
	for (const scope of [
		"containers",
		"images",
		"builders",
		"volumes",
		"all",
	] as const) {
		assert.match(
			cleanupAction(scope).description,
			/Panara Cloud did not create/,
			scope,
		);
	}
});

test("deleting volumes says the data goes and cannot come back", () => {
	const volumes = cleanupAction("volumes");
	assert.match(volumes.description, /with its data/);
	assert.match(volumes.description, /can't be undone/);
	assert.equal(volumes.confirmLabel, "Delete volumes");
	for (const action of CLEANUP_ACTIONS) {
		if (action.scope === "volumes") continue;
		assert.doesNotMatch(action.description, /Deletes every volume/);
	}
});

test("every clean-up asks first, with its own question and result", () => {
	const scopes = CLEANUP_ACTIONS.map((action) => action.scope);
	assert.equal(new Set(scopes).size, scopes.length);
	for (const action of CLEANUP_ACTIONS) {
		assert.match(action.label, /…$/, action.scope);
		assert.match(action.title, /\?$/, action.scope);
		assert.ok(action.description.length > 40, action.scope);
		assert.ok(action.done, action.scope);
	}
	assert.deepEqual(
		CLEANUP_ACTIONS.filter((action) => action.panelOnly).map(
			(action) => action.scope,
		),
		["monitoring"],
	);
});
