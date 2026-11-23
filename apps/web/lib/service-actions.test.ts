import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityLabel,
	bulkActionState,
	NOTHING_DEPLOYED,
	SERVICE_ACTIONS,
	type ServiceAction,
	type ServiceActivity,
	type ServiceRuntime,
	type ServiceStatus,
	serviceActionState,
	serviceStatusWord,
} from "./service-actions.ts";

const runtime = (
	deployed: boolean,
	activity: ServiceActivity | null = null,
	deployState: ServiceRuntime["deployState"] = deployed ? "deployed" : "never",
): ServiceRuntime => ({ deployed, activity, deployState });

const disabled = (
	status: ServiceStatus,
	state?: ServiceRuntime,
	server?: "ready" | "inactive" | "offline" | "notSetUp",
) => {
	const states = serviceActionState({ status }, state, { server });
	return Object.fromEntries(
		SERVICE_ACTIONS.flatMap((action) =>
			states[action].enabled ? [] : [[action, states[action].reason]],
		),
	) as Partial<Record<ServiceAction, string>>;
};

const NOTHING_RUNNING = {
	cancel: "Nothing to cancel",
	killBuild: "No build running",
	cancelQueued: "Nothing queued",
};

const ALWAYS: ServiceAction[] = [
	"logs",
	"copyHost",
	"containers",
	"move",
	"duplicate",
	"delete",
];

test("a live service can do everything but start and cancel", () => {
	assert.deepEqual(disabled("done", runtime(true)), {
		start: "Already running",
		...NOTHING_RUNNING,
	});
});

test("a service that was never deployed can only be deployed", () => {
	const reasons = disabled("idle", runtime(false));
	for (const action of [
		"redeployImage",
		"rebuild",
		"reload",
		"start",
		"stop",
		"rollback",
		"terminal",
		"visit",
		"backup",
		"restore",
		"volumeBackup",
		"runSchedule",
	] as const) {
		assert.equal(reasons[action], NOTHING_DEPLOYED, action);
	}
	assert.equal(reasons.deploy, undefined);
	assert.equal(reasons.transfer, undefined);
});

test("a first deploy that failed left nothing to restart, stop or start", () => {
	const reasons = disabled("error", runtime(false));
	for (const action of ["reload", "start", "stop"] as const) {
		assert.equal(reasons[action], NOTHING_DEPLOYED, action);
	}
	assert.deepEqual(reasons, disabled("idle", runtime(false)));
	assert.equal(reasons.deploy, undefined);
	for (const action of ALWAYS) assert.equal(reasons[action], undefined, action);
	assert.equal(
		NOTHING_DEPLOYED,
		"Nothing is deployed yet. Deploy first.",
		"the reason is the backend's refusal, word for word",
	);
});

test("until the deploy state loads, a failed row claims no reason it can't know", () => {
	assert.deepEqual(disabled("error"), NOTHING_RUNNING);
});

test("a stopped service starts, deploys and rebuilds, but has no container", () => {
	assert.deepEqual(disabled("idle", runtime(true)), {
		stop: "Already stopped",
		reload: "Stopped",
		terminal: "Stopped",
		visit: "Stopped",
		backup: "Stopped",
		restore: "Stopped",
		runSchedule: "Stopped",
		...NOTHING_RUNNING,
	});
});

test("a deployed service whose later deploy failed keeps every action", () => {
	assert.deepEqual(disabled("error", runtime(true)), NOTHING_RUNNING);
});

test("while a deploy runs, nothing that would queue behind it is offered", () => {
	const reasons = disabled(
		"running",
		runtime(true, { kind: "deploying", status: "running" }, "deploying"),
	);
	assert.deepEqual(reasons, {
		deploy: "Deploying…",
		redeployImage: "Deploying…",
		rebuild: "Deploying…",
		reload: "Deploying…",
		start: "Deploying…",
		stop: "Deploying…",
		rollback: "Deploying…",
		transfer: "Deploying…",
		backup: "Deploying…",
		restore: "Deploying…",
		volumeBackup: "Deploying…",
		cancelQueued: "Nothing queued",
	});
});

test("a build can be killed while it runs, the queue cleared while something waits", () => {
	const running = (waiting: number) =>
		disabled(
			"running",
			runtime(true, { kind: "deploying", status: "running", waiting }),
		);
	assert.equal(running(0).killBuild, undefined);
	assert.equal(running(0).cancelQueued, "Nothing queued");
	assert.equal(running(2).cancelQueued, undefined);
	const queued = disabled(
		"idle",
		runtime(true, { kind: "deploying", status: "queued" }),
	);
	assert.equal(queued.killBuild, "No build running");
	assert.equal(queued.cancelQueued, undefined);
	const stopping = disabled(
		"done",
		runtime(true, { kind: "stopping", status: "running" }),
	);
	assert.equal(stopping.killBuild, "No build running");
});

test("the version before stays reachable during a redeploy, not during a first deploy", () => {
	const first = disabled(
		"running",
		runtime(false, { kind: "deploying", status: "running" }, "deploying"),
	);
	assert.equal(first.visit, NOTHING_DEPLOYED);
	assert.equal(first.terminal, NOTHING_DEPLOYED);
	assert.equal(first.cancel, undefined);
	const again = disabled(
		"running",
		runtime(true, { kind: "deploying", status: "running" }, "deploying"),
	);
	assert.equal(again.visit, undefined);
	assert.equal(again.terminal, undefined);
});

test("a queued job blocks like a running one and says what waits", () => {
	const queuedDeploy = disabled(
		"idle",
		runtime(false, { kind: "deploying", status: "queued" }, "deploying"),
	);
	assert.equal(queuedDeploy.deploy, "Deploy queued");
	assert.equal(queuedDeploy.cancel, undefined);
	const stopping = disabled(
		"done",
		runtime(true, { kind: "stopping", status: "queued" }),
	);
	assert.equal(stopping.deploy, "Stop queued");
	assert.equal(stopping.stop, "Stop queued");
	assert.equal(stopping.start, "Stop queued");
	assert.equal(stopping.visit, undefined);
});

test("every activity has its own words", () => {
	const labels = (
		[
			"deploying",
			"rollingBack",
			"transferring",
			"starting",
			"stopping",
			"restarting",
			"backingUp",
			"restoring",
		] as const
	).map((kind) => activityLabel({ kind, status: "running" }));
	assert.equal(new Set(labels).size, labels.length);
	assert.equal(
		activityLabel({
			kind: "deploying",
			status: "running",
			cancelRequested: true,
		}),
		"Cancelling…",
	);
});

test("a cancelled job can't be cancelled twice and still blocks", () => {
	const reasons = disabled(
		"running",
		runtime(
			true,
			{ kind: "deploying", status: "running", cancelRequested: true },
			"deploying",
		),
	);
	assert.equal(reasons.cancel, "Cancelling…");
	assert.equal(reasons.deploy, "Cancelling…");
});

test("a status of running without a job still counts as deploying", () => {
	const reasons = disabled("running", runtime(true));
	assert.equal(reasons.deploy, "Deploying…");
	assert.equal(reasons.cancel, "Nothing to cancel");
});

test("a server that can't take work blocks what runs on it, nothing else", () => {
	for (const [server, reason] of [
		["inactive", "Server inactive"],
		["offline", "Server offline"],
		["notSetUp", "Server not set up"],
	] as const) {
		const reasons = disabled("done", runtime(true), server);
		for (const action of [
			"deploy",
			"redeployImage",
			"rebuild",
			"reload",
			"stop",
			"rollback",
			"terminal",
			"backup",
			"restore",
			"volumeBackup",
			"runSchedule",
		] as const) {
			assert.equal(reasons[action], reason, `${server} ${action}`);
		}
		assert.equal(reasons.transfer, undefined);
		assert.equal(reasons.visit, undefined);
	}
	assert.deepEqual(disabled("done", runtime(true), "ready"), {
		start: "Already running",
		...NOTHING_RUNNING,
	});
});

test("what is in progress explains more than the server", () => {
	const reasons = disabled(
		"idle",
		runtime(false, { kind: "deploying", status: "queued" }, "deploying"),
		"offline",
	);
	assert.equal(reasons.deploy, "Deploy queued");
	assert.equal(reasons.cancel, undefined);
});

test("reading, copying, moving and deleting never depend on the state", () => {
	const cases: [ServiceStatus, ServiceRuntime | undefined][] = [
		["idle", undefined],
		["idle", runtime(false)],
		["idle", runtime(true)],
		["done", runtime(true)],
		["error", runtime(false)],
		["running", runtime(true, { kind: "deploying", status: "running" })],
		["idle", runtime(false, { kind: "deploying", status: "queued" })],
	];
	for (const [status, state] of cases) {
		for (const server of [undefined, "offline", "inactive"] as const) {
			const states = serviceActionState({ status }, state, { server });
			for (const action of ALWAYS) {
				assert.deepEqual(states[action], { enabled: true }, action);
			}
		}
	}
});

test("without the deploy state the rule goes by the status alone", () => {
	const idle = disabled("idle");
	assert.equal(idle.stop, "Not running");
	assert.equal(idle.terminal, "Not running");
	assert.equal(idle.start, undefined);
	assert.equal(idle.deploy, undefined);
	assert.equal(disabled("running").deploy, "Deploying…");
	assert.equal(disabled("done").start, "Already running");
});

test("every disabled action has a reason, every enabled one has none", () => {
	for (const status of ["idle", "running", "done", "error"] as const) {
		for (const state of [
			undefined,
			runtime(false),
			runtime(true),
			runtime(true, { kind: "restoring", status: "running" }),
		]) {
			const states = serviceActionState({ status }, state);
			for (const action of SERVICE_ACTIONS) {
				const { enabled, reason } = states[action];
				assert.equal(Boolean(reason), !enabled, `${status} ${action}`);
			}
		}
	}
});

test("a bulk action runs on the services that can take it", () => {
	const live = serviceActionState({ status: "done" }, runtime(true));
	const stopped = serviceActionState({ status: "idle" }, runtime(true));
	const fresh = serviceActionState({ status: "idle" }, runtime(false));
	assert.deepEqual(bulkActionState([live, stopped, fresh], "stop"), {
		enabled: true,
		eligible: [0],
	});
	assert.deepEqual(bulkActionState([stopped, stopped], "stop"), {
		enabled: false,
		eligible: [],
		reason: "Already stopped",
	});
	assert.deepEqual(bulkActionState([stopped, fresh], "stop"), {
		enabled: false,
		eligible: [],
		reason: "Not possible for the selected services",
	});
	assert.deepEqual(bulkActionState([], "deploy"), {
		enabled: false,
		eligible: [],
	});
	assert.deepEqual(bulkActionState([live, fresh], "delete").eligible, [0, 1]);
});

test("a selection of services whose first deploy failed can be deployed, not restarted, started or stopped", () => {
	const failedFirst = serviceActionState({ status: "error" }, runtime(false));
	const live = serviceActionState({ status: "done" }, runtime(true));
	for (const action of ["reload", "start", "stop"] as const) {
		assert.deepEqual(
			bulkActionState([failedFirst, failedFirst], action),
			{ enabled: false, eligible: [], reason: NOTHING_DEPLOYED },
			action,
		);
	}
	assert.deepEqual(bulkActionState([failedFirst, live], "stop"), {
		enabled: true,
		eligible: [1],
	});
	assert.deepEqual(bulkActionState([failedFirst, failedFirst], "deploy"), {
		enabled: true,
		eligible: [0, 1],
	});
});

test("the status word tells stopped from never deployed, and queued from deploying", () => {
	assert.equal(serviceStatusWord("done", runtime(true)), "live");
	assert.equal(serviceStatusWord("error", runtime(false)), "failed");
	assert.equal(serviceStatusWord("idle", runtime(true)), "stopped");
	assert.equal(serviceStatusWord("idle", runtime(false)), "notDeployed");
	assert.equal(serviceStatusWord("idle"), "notDeployed");
	assert.equal(
		serviceStatusWord(
			"idle",
			runtime(false, { kind: "deploying", status: "queued" }, "deploying"),
		),
		"queued",
	);
	assert.equal(
		serviceStatusWord(
			"running",
			runtime(true, { kind: "deploying", status: "running" }, "deploying"),
		),
		"deploying",
	);
	assert.equal(
		serviceStatusWord(
			"done",
			runtime(true, { kind: "stopping", status: "queued" }),
		),
		"live",
	);
});
