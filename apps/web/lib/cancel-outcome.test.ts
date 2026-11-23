import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelOutcome, TOO_LATE_TO_CANCEL } from "./cancel-outcome.ts";

test("a job that is waiting, running or still loading has no outcome yet", () => {
	assert.equal(cancelOutcome(undefined), "pending");
	assert.equal(cancelOutcome({ status: "queued" }), "pending");
	assert.equal(cancelOutcome({ status: "running" }), "pending");
});

test("a job the cancel stopped is cancelled", () => {
	assert.equal(cancelOutcome({ status: "cancelled" }), "cancelled");
	// Cleared from the history meanwhile: nothing is running any more.
	assert.equal(cancelOutcome(null), "cancelled");
});

test("a job that finished all the same was cancelled too late", () => {
	assert.equal(cancelOutcome({ status: "succeeded" }), "tooLate");
	assert.match(TOO_LATE_TO_CANCEL.description, /nothing was stopped/);
});

test("a job that failed by itself is not called cancelled", () => {
	assert.equal(cancelOutcome({ status: "failed" }), "failed");
});
