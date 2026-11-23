import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectorStarting,
	monitoringDeployedAt,
	STARTING_WINDOW_MS,
} from "./monitoring-start.ts";

const NOW = 1_800_000_000_000;
const ENOTFOUND =
	"request to http://panara-cloud-monitoring:4500/metrics failed, reason: getaddrinfo ENOTFOUND panara-cloud-monitoring";

test("a collector that does not answer right after set-up is starting", () => {
	for (const error of [
		ENOTFOUND,
		"connect ECONNREFUSED 10.0.1.7:4500",
		"The monitoring service did not answer",
		"fetch failed",
	]) {
		assert.equal(
			collectorStarting({ error, deployedAt: NOW - 20_000, now: NOW }),
			true,
			error,
		);
	}
});

test("the same error long after set-up, or another error, is a failure", () => {
	assert.equal(
		collectorStarting({
			error: ENOTFOUND,
			deployedAt: NOW - STARTING_WINDOW_MS - 1,
			now: NOW,
		}),
		false,
	);
	assert.equal(
		collectorStarting({ error: ENOTFOUND, deployedAt: null, now: NOW }),
		false,
	);
	assert.equal(
		collectorStarting({
			error: "401 Unauthorized",
			deployedAt: NOW - 20_000,
			now: NOW,
		}),
		false,
	);
});

test("the set-up time comes from the monitoring job", () => {
	assert.equal(monitoringDeployedAt(null, NOW), null);
	assert.equal(
		monitoringDeployedAt({ status: "running", _creationTime: 5 }, NOW),
		NOW,
	);
	assert.equal(
		monitoringDeployedAt({ status: "queued", _creationTime: 5 }, NOW),
		NOW,
	);
	assert.equal(
		monitoringDeployedAt(
			{ status: "succeeded", finishedAt: 42, _creationTime: 5 },
			NOW,
		),
		42,
	);
	assert.equal(
		monitoringDeployedAt({ status: "succeeded", _creationTime: 5 }, NOW),
		5,
	);
	assert.equal(
		monitoringDeployedAt(
			{ status: "failed", finishedAt: 42, _creationTime: 5 },
			NOW,
		),
		null,
	);
});

test("a collector on another server that is not listening yet is starting too", () => {
	// What the agent reports through its SSH connection to a server, as seen
	// right after "Turn on monitoring" on a deploy server.
	const overSsh = "(SSH) Channel open failure: Connection refused";
	assert.equal(
		collectorStarting({ error: overSsh, deployedAt: NOW - 3_000, now: NOW }),
		true,
	);
	// Long after the set-up it is a failure again, with its Try again button.
	assert.equal(
		collectorStarting({
			error: overSsh,
			deployedAt: NOW - STARTING_WINDOW_MS - 1,
			now: NOW,
		}),
		false,
	);
});
