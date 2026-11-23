import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ContainerSelection,
	nextContainerSelection,
} from "./container-selection.ts";

const NONE: ContainerSelection = {
	containerId: undefined,
	followed: undefined,
};
const running = (containerId: string) => ({ containerId, state: "running" });
const exited = (containerId: string) => ({ containerId, state: "exited" });

test("nothing changes until the containers are listed", () => {
	assert.equal(nextContainerSelection(NONE, undefined), NONE);
});

test("the first container is read when none is picked or the picked one is gone", () => {
	assert.deepEqual(nextContainerSelection(NONE, [running("a"), exited("b")]), {
		containerId: "a",
		followed: "a",
	});
	assert.deepEqual(
		nextContainerSelection({ containerId: "gone", followed: "gone" }, [
			exited("b"),
		]),
		{ containerId: "b", followed: undefined },
	);
	assert.deepEqual(
		nextContainerSelection({ containerId: "a", followed: "a" }, []),
		NONE,
	);
});

test("a running container stays picked, and the same selection is returned", () => {
	const current = { containerId: "b", followed: "b" };
	assert.equal(
		nextContainerSelection(current, [running("a"), running("b")]),
		current,
	);
});

test("the tail moves to the container that replaced the one it followed", () => {
	// A restart that starts the new container first.
	assert.deepEqual(
		nextContainerSelection({ containerId: "old", followed: "old" }, [
			running("new"),
			exited("old"),
		]),
		{ containerId: "new", followed: "new" },
	);
	// One that stops the old container first: it waits for the new one.
	const waiting = nextContainerSelection(
		{ containerId: "old", followed: "old" },
		[exited("old")],
	);
	assert.deepEqual(waiting, { containerId: "old", followed: "old" });
	assert.deepEqual(
		nextContainerSelection(waiting, [running("new"), exited("old")]),
		{ containerId: "new", followed: "new" },
	);
});

test("a container picked after it stopped is kept", () => {
	const picked = nextContainerSelection(
		{ containerId: "old", followed: undefined },
		[running("new"), exited("old")],
	);
	assert.deepEqual(picked, { containerId: "old", followed: undefined });
});

test("a Swarm task counts as running by its desired state", () => {
	assert.deepEqual(
		nextContainerSelection({ containerId: "t1", followed: "t1" }, [
			{ containerId: "t2", state: "running" },
			{ containerId: "t1", state: "shutdown" },
		]),
		{ containerId: "t2", followed: "t2" },
	);
});
