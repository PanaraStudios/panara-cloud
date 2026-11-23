/* Which actions a service can take right now, and why not.

   Every place that offers a service action (header, menus, lists, the
   command menu, shortcuts, settings) reads this one table, so a rule changes
   here and nowhere else.

   What it encodes about the backend: jobs of one service share a group and
   run one at a time, so anything started while a job is queued or running is
   not refused, it waits behind it and runs afterwards (a Stop pressed during
   a deploy stops the new version once it is up). Restart, start and stop
   act on what a deploy created: until one has succeeded the backend refuses
   them (`assertDeployed`), however the first deploy ended. */

export type ServiceStatus = "idle" | "running" | "done" | "error";

export type ServiceActivityKind =
	| "deploying"
	| "rollingBack"
	| "transferring"
	| "starting"
	| "stopping"
	| "restarting"
	| "backingUp"
	| "restoring";

export type ServiceActivity = {
	kind: ServiceActivityKind;
	status: "queued" | "running";
	cancelRequested?: boolean;
	/** Jobs waiting behind this one. */
	waiting?: number;
};

/** From `serviceEvents.pendingChanges` / `pendingChangeCounts`. */
export type ServiceRuntime = {
	deployState: "never" | "deploying" | "deployed";
	/** A deploy has succeeded at some point. */
	deployed: boolean;
	activity: ServiceActivity | null;
};

/** The server the service runs on; undefined when unknown or fine. */
export type ServerState = "ready" | "inactive" | "offline" | "notSetUp";

export type ServiceActionContext = { server?: ServerState };

export const SERVICE_ACTIONS = [
	"deploy",
	"redeployImage",
	"rebuild",
	"reload",
	"start",
	"stop",
	"cancel",
	"killBuild",
	"cancelQueued",
	"rollback",
	"transfer",
	"terminal",
	"visit",
	"backup",
	"restore",
	"volumeBackup",
	"runSchedule",
	"logs",
	"copyHost",
	"containers",
	"move",
	"duplicate",
	"delete",
] as const;

export type ServiceAction = (typeof SERVICE_ACTIONS)[number];
export type ActionState = { enabled: boolean; reason?: string };
export type ServiceActionStates = Record<ServiceAction, ActionState>;

const ACTIVITY_LABELS: Record<
	ServiceActivityKind,
	{ running: string; queued: string }
> = {
	deploying: { running: "Deploying…", queued: "Deploy queued" },
	rollingBack: { running: "Rolling back…", queued: "Rollback queued" },
	transferring: {
		running: "Moving to another server…",
		queued: "Transfer queued",
	},
	starting: { running: "Starting…", queued: "Start queued" },
	stopping: { running: "Stopping…", queued: "Stop queued" },
	restarting: { running: "Restarting…", queued: "Restart queued" },
	backingUp: { running: "Backup running…", queued: "Backup queued" },
	restoring: { running: "Restore running…", queued: "Restore queued" },
};

/** What the service is busy with, in the words the reasons use. */
export function activityLabel(activity: ServiceActivity) {
	if (activity.cancelRequested) return "Cancelling…";
	return ACTIVITY_LABELS[activity.kind][activity.status];
}

const SERVER_REASONS: Record<Exclude<ServerState, "ready">, string> = {
	inactive: "Server inactive",
	offline: "Server offline",
	notSetUp: "Server not set up",
};

// Start a job that would wait behind the one in progress.
const WAITS_WHILE_BUSY: ReadonlySet<ServiceAction> = new Set([
	"deploy",
	"redeployImage",
	"rebuild",
	"reload",
	"start",
	"stop",
	"rollback",
	"transfer",
	"backup",
	"restore",
	"volumeBackup",
]);

// Run on the service's server. A transfer is left out: moving away is what
// you do with a server that is gone.
const NEEDS_SERVER: ReadonlySet<ServiceAction> = new Set([
	"deploy",
	"redeployImage",
	"rebuild",
	"reload",
	"start",
	"stop",
	"rollback",
	"terminal",
	"backup",
	"restore",
	"volumeBackup",
	"runSchedule",
]);

// Need what a first deploy creates: the service, its image or its code.
const NEEDS_DEPLOY: ReadonlySet<ServiceAction> = new Set([
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
]);

// Need a running container.
const NEEDS_RUNNING: ReadonlySet<ServiceAction> = new Set([
	"reload",
	"terminal",
	"visit",
	"backup",
	"restore",
	"runSchedule",
]);

type RunState = "live" | "failed" | "stopped" | "notDeployed" | "unknown";

function runStateOf(
	status: ServiceStatus,
	runtime: ServiceRuntime | undefined,
): RunState {
	if (status === "done") return "live";
	// Before anything else: a first deploy that failed or was cancelled left
	// nothing to restart, stop or start.
	if (runtime && !runtime.deployed) return "notDeployed";
	// A failed deploy leaves the version before it, running or crashing.
	if (status === "error") return "failed";
	if (!runtime) return status === "running" ? "live" : "unknown";
	// While a deploy runs the version before it keeps serving.
	return status === "running" ? "live" : "stopped";
}

/** The reason every job-starting action waits, or null when the service is free. */
export function busyReason(
	status: ServiceStatus,
	runtime: ServiceRuntime | undefined,
): string | null {
	if (runtime?.activity) return activityLabel(runtime.activity);
	if (status === "running" || runtime?.deployState === "deploying") {
		return "Deploying…";
	}
	return null;
}

export type ServiceStatusWord =
	| "live"
	| "deploying"
	| "queued"
	| "failed"
	| "stopped"
	| "notDeployed";

/** The one status vocabulary, from the same facts the actions go by. Without
    the deploy state an idle service can't be told from a stopped one and
    reads as not deployed. */
export function serviceStatusWord(
	status: ServiceStatus,
	runtime?: Pick<ServiceRuntime, "deployState" | "activity">,
): ServiceStatusWord {
	const activity = runtime?.activity;
	if (
		status !== "running" &&
		activity?.kind === "deploying" &&
		activity.status === "queued"
	) {
		return "queued";
	}
	if (status === "running" || runtime?.deployState === "deploying") {
		return "deploying";
	}
	if (status === "error") return "failed";
	if (status === "done") return "live";
	return runtime && runtime.deployState !== "never" ? "stopped" : "notDeployed";
}

/** The backend's own words when it refuses the same thing. */
export const NOTHING_DEPLOYED = "Nothing is deployed yet. Deploy first.";

const ENABLED: ActionState = { enabled: true };
const blocked = (reason: string): ActionState => ({ enabled: false, reason });

/** `runtime` is undefined while it loads (or for rows a list has no detail
    for): the rule then goes by the status alone and never claims a reason
    it can't know. */
export function serviceActionState(
	service: { status: ServiceStatus },
	runtime?: ServiceRuntime,
	context: ServiceActionContext = {},
): ServiceActionStates {
	const busy = busyReason(service.status, runtime);
	const run = runStateOf(service.status, runtime);
	const server =
		context.server && context.server !== "ready"
			? SERVER_REASONS[context.server]
			: null;

	const stateOf = (action: ServiceAction): ActionState => {
		if (action === "cancel") {
			if (!runtime?.activity) return blocked("Nothing to cancel");
			return runtime.activity.cancelRequested
				? blocked("Cancelling…")
				: ENABLED;
		}
		if (action === "killBuild") {
			const activity = runtime?.activity;
			return activity?.kind === "deploying" && activity.status === "running"
				? ENABLED
				: blocked("No build running");
		}
		if (action === "cancelQueued") {
			const activity = runtime?.activity;
			return activity &&
				(activity.status === "queued" || (activity.waiting ?? 0) > 0)
				? ENABLED
				: blocked("Nothing queued");
		}
		if (busy && WAITS_WHILE_BUSY.has(action)) return blocked(busy);
		if (server && NEEDS_SERVER.has(action)) return blocked(server);
		if (run === "notDeployed" && NEEDS_DEPLOY.has(action)) {
			return blocked(NOTHING_DEPLOYED);
		}
		if (run === "stopped") {
			if (action === "stop") return blocked("Already stopped");
			if (NEEDS_RUNNING.has(action)) return blocked("Stopped");
		}
		if (run === "unknown" && (action === "stop" || NEEDS_RUNNING.has(action))) {
			return blocked("Not running");
		}
		if (run === "live" && action === "start") {
			return blocked("Already running");
		}
		return ENABLED;
	};

	return Object.fromEntries(
		SERVICE_ACTIONS.map((action) => [action, stateOf(action)]),
	) as ServiceActionStates;
}

/** One action over a selection: enabled when at least one selected service
    can take it; `eligible` are the indexes it then runs on. */
export function bulkActionState(
	states: ServiceActionStates[],
	action: ServiceAction,
): ActionState & { eligible: number[] } {
	const eligible = states.flatMap((state, index) =>
		state[action].enabled ? [index] : [],
	);
	if (eligible.length > 0 || states.length === 0) {
		return { enabled: states.length > 0, eligible };
	}
	const reasons = new Set(states.map((state) => state[action].reason));
	const [only] = reasons;
	return {
		enabled: false,
		eligible,
		reason:
			reasons.size === 1 && only
				? only
				: "Not possible for the selected services",
	};
}
